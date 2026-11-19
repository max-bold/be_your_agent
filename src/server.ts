import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { Workbench } from './workbench.js';
import { McpConnections } from './mcp.js';
import { InputError, object } from './validation.js';
import { streamResponse } from './protocols/responses.js';
import { parseAnswer } from './protocols/requests.js';
import { modelResponse } from './protocols/responses.js';
import { Upstreams, runProxy } from './proxy.js';
import type { Protocol } from './types.js';

interface Options {
  directory: string;
  apiToken?: string;
  webDirectory?: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const routes = new Map<string, Protocol>([
  ['/v1/messages', 'anthropic'],
  ['/v1/chat/completions', 'chat-completions'],
  ['/v1/responses', 'responses'],
]);

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new InputError('Request exceeds 32 MiB', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Invalid JSON body');
  }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function startEvents(response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
}

export async function createWorkbenchServer(options: Options) {
  const workbench = new Workbench(options.directory);
  const mcp = new McpConnections(options.directory);
  const upstreams = new Upstreams(options.directory);
  await Promise.all([workbench.load(), mcp.load(), upstreams.load()]);
  const proxyJobs = new Map<string, AbortController>();
  const subscribers = new Set<ServerResponse>();
  const notify = () => {
    for (const response of subscribers) response.write('event: change\ndata: {}\n\n');
  };
  workbench.on('change', notify);
  mcp.on('change', notify);
  upstreams.on('change', notify);
  workbench.on('live', (value) => {
    for (const response of subscribers)
      response.write(`event: live\ndata: ${JSON.stringify(value)}\n\n`);
  });
  const webDirectory = options.webDirectory ?? resolve('web');
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/schema.js', ['schema.js', 'text/javascript; charset=utf-8']],
    ['/content.js', ['content.js', 'text/javascript; charset=utf-8']],
    ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ]);
  let stopping = false;
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 4320;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = request.headers.origin;
    let protocol: Protocol | undefined;
    try {
      if (stopping) throw new InputError('Server is shutting down', 503);
      if (
        !allowedHosts.includes(request.headers.host ?? '') ||
        (origin && !allowedHosts.some((host) => origin === `http://${host}`)) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      )
        throw new InputError('Local same-origin access only', 403);
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      const scoped = /^\/chats\/([^/]+)(\/v1\/.*)$/.exec(url.pathname);
      const path = scoped?.[2] ?? url.pathname;
      protocol = routes.get(path);
      const isModel = Boolean(protocol) || path === '/v1/models';
      if (isModel && options.apiToken) {
        const supplied =
          request.headers.authorization?.replace(/^Bearer /i, '') ?? request.headers['x-api-key'];
        if (
          typeof supplied !== 'string' ||
          !timingSafeEqual(digest(supplied), digest(options.apiToken))
        )
          throw new InputError('Invalid API key', 401);
      }
      if (request.method === 'GET' && assets.has(path)) {
        const [name, type] = assets.get(path)!;
        response.writeHead(200, { 'content-type': type });
        response.end(await readFile(join(webDirectory, name)));
        return;
      }
      if (request.method === 'GET' && path === '/v1/models') {
        json(response, 200, {
          object: 'list',
          data: [{ id: 'human', object: 'model', created: 0, owned_by: 'be-your-agent' }],
        });
        return;
      }
      if (request.method === 'POST' && protocol) {
        const input = await body(request);
        const { request: modelRequest, answer } = await workbench.accept(protocol, input, {
          'chat URL': scoped?.[1],
          'X-Chat-Id': request.headers['x-chat-id'],
          'metadata.chat_id': input.metadata?.chat_id,
        });
        const chatId = modelRequest.chatId;
        const controller = new AbortController();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const cancel = () => {
          if (!response.writableEnded) {
            controller.abort();
            void workbench.cancel(modelRequest.id, 'Client disconnected').catch(console.error);
          }
        };
        response.on('close', cancel);
        // A socket may close while history is being saved.
        if (response.destroyed) {
          await workbench.cancel(modelRequest.id, 'Client disconnected');
          return;
        }
        try {
          if (workbench.mode(chatId) === 'proxy') {
            proxyJobs.set(modelRequest.id, controller);
            void (async () => {
              try {
                const result = await runProxy(
                  workbench.routing.effectiveRequest(modelRequest),
                  upstreams.get(workbench.upstreamId(chatId)),
                  mcp,
                  workbench,
                  controller.signal,
                );
                await workbench.finishProxy(modelRequest.id, result);
              } catch (error) {
                await workbench.cancel(
                  modelRequest.id,
                  error instanceof Error ? error.message : String(error),
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
            })().catch(console.error);
          }
          if (modelRequest.stream) {
            startEvents(response);
            response.write(': waiting for human response\n\n');
            heartbeat = setInterval(() => response.write(': waiting\n\n'), 10000);
            heartbeat.unref();
          }
          const result = await answer;
          if (response.destroyed) return;
          if (modelRequest.stream) {
            for (const event of streamResponse(modelRequest, result)) {
              if (event.event) response.write(`event: ${event.event}\n`);
              response.write(
                `data: ${event.data === '[DONE]' ? '[DONE]' : JSON.stringify(event.data)}\n\n`,
              );
            }
            response.end();
          } else json(response, 200, result);
        } finally {
          clearInterval(heartbeat);
          response.off('close', cancel);
          proxyJobs.delete(modelRequest.id);
        }
        return;
      }
      const context = /^\/api\/requests\/([^/]+)\/context$/.exec(path);
      if (request.method === 'GET' && context) {
        json(
          response,
          200,
          workbench.routing.effectiveRequest(workbench.getRequest(context[1])).body,
        );
        return;
      }
      if (request.method === 'GET' && path === '/api/state') {
        json(response, 200, {
          ...workbench.snapshot(),
          mcp: mcp.snapshot(),
          upstreams: upstreams.snapshot(),
          apiTokenRequired: Boolean(options.apiToken),
        });
        return;
      }
      if (request.method === 'GET' && path === '/api/events') {
        startEvents(response);
        response.write('event: change\ndata: {}\n\n');
        subscribers.add(response);
        const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
        response.on('close', () => {
          clearInterval(heartbeat);
          subscribers.delete(response);
        });
        return;
      }
      if (request.method !== 'POST' || request.headers['x-be-your-agent'] !== 'workbench')
        throw new InputError('Not found', 404);
      const input = await body(request);
      if (path === '/api/chats') {
        json(response, 201, await workbench.createChat(String(input.name ?? 'Untitled chat')));
        return;
      }
      if (path === '/api/upstreams') {
        await upstreams.save(input);
        json(response, 200, { ok: true });
        return;
      }
      const removeModel = /^\/api\/upstreams\/([^/]+)\/remove$/.exec(path);
      if (removeModel) {
        await upstreams.remove(removeModel[1]);
        json(response, 200, { ok: true });
        return;
      }
      const toggle = /^\/api\/upstreams\/([^/]+)\/enabled$/.exec(path);
      if (toggle) {
        if (typeof input.enabled !== 'boolean') throw new InputError('Expected enabled flag');
        await upstreams.enable(toggle[1], input.enabled);
        json(response, 200, { ok: true });
        return;
      }
      const selection = /^\/api\/chats\/([^/]+)\/upstream$/.exec(path);
      if (selection) {
        const config = upstreams.get(String(input.id));
        await workbench.setUpstream(selection[1], config.id);
        json(response, 200, { ok: true });
        return;
      }
      const mode = /^\/api\/chats\/([^/]+)\/mode$/.exec(path);
      if (mode) {
        if (!['human', 'proxy'].includes(input.mode)) throw new InputError('Unknown mode');
        await workbench.setMode(mode[1], input.mode);
        json(response, 200, { ok: true });
        return;
      }
      const rename = /^\/api\/chats\/([^/]+)$/.exec(path);
      if (rename) {
        json(response, 200, await workbench.renameChat(rename[1], String(input.name ?? '')));
        return;
      }
      const answer = /^\/api\/requests\/([^/]+)\/(answer|cancel|preview)$/.exec(path);
      if (answer) {
        if (answer[2] === 'preview') {
          const request = workbench.getRequest(answer[1]);
          json(response, 200, modelResponse(request, parseAnswer(request, input)));
          return;
        }
        if (answer[2] === 'answer') json(response, 200, await workbench.answer(answer[1], input));
        else {
          proxyJobs.get(answer[1])?.abort();
          await workbench.cancel(answer[1], 'Cancelled by operator');
          json(response, 200, { ok: true });
        }
        return;
      }
      if (path === '/api/mcp/save') {
        json(response, 200, await mcp.save(input));
        return;
      }
      const operation = /^\/api\/mcp\/([^/]+)\/(connect|disconnect|remove|refresh|call)$/.exec(
        path,
      );
      if (operation) {
        const [, id, action] = operation;
        if (action === 'call') {
          const chatId = String(input.chatId ?? 'default');
          if (!workbench.hasChat(chatId)) throw new InputError('Chat not found', 404);
          const started = Date.now();
          const serverName = mcp.snapshot().find((c) => c.id === id)?.name ?? id;
          const name = String(input.name ?? '');
          await workbench.entry(chatId, 'tool-call', serverName + ' / ' + name, {
            serverId: id,
            name,
            arguments: input.arguments ?? {},
          });
          // Resolve the chat and tool before awaiting: navigation cannot redirect the result.
          try {
            const result = await mcp.call(id, name, input.arguments ?? {});
            await workbench.entry(chatId, 'tool-result', `${serverName} / ${name}`, {
              serverId: id,
              name,
              arguments: input.arguments ?? {},
              durationMs: Date.now() - started,
              result,
            });
            json(response, 200, result);
          } catch (error) {
            await workbench.entry(chatId, 'error', `${serverName} / ${name}`, {
              serverId: id,
              name,
              arguments: input.arguments ?? {},
              durationMs: Date.now() - started,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        } else {
          await mcp[action as 'connect' | 'disconnect' | 'remove' | 'refresh'](id);
          json(response, 200, { ok: true });
        }
        return;
      }
      throw new InputError('Not found', 404);
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? z.prettifyError(error)
          : error instanceof Error
            ? error.message
            : 'Request failed';
      const status =
        error instanceof InputError ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (response.destroyed) return;
      if (response.headersSent) {
        const event =
          protocol === 'anthropic'
            ? { type: 'error', error: { type: 'api_error', message } }
            : { type: 'error', message, code: 'request_failed' };
        response.end(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
      } else
        json(
          response,
          status,
          protocol === 'anthropic'
            ? { type: 'error', error: { type: 'invalid_request_error', message } }
            : {
                error: {
                  message,
                  type: 'invalid_request_error',
                  code: null,
                  ...(error instanceof InputError && error.param ? { param: error.param } : {}),
                },
              },
        );
    }
  });
  // Human responses can take arbitrarily long. Body reception still has a finite timeout.
  server.timeout = 0;
  server.requestTimeout = 60000;
  return {
    server,
    workbench,
    mcp,
    upstreams,
    async close() {
      stopping = true;
      for (const controller of proxyJobs.values()) controller.abort();
      await workbench.close();
      for (const subscriber of subscribers) subscriber.end();
      await mcp.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
