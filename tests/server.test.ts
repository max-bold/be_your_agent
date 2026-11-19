import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createWorkbenchServer } from '../src/server.js';
import { modelResponse, streamResponse } from '../src/protocols/responses.js';
import { parseModelRequest } from '../src/protocols/requests.js';
import type { Protocol } from '../src/types.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'be-your-agent-'));
  const service = await createWorkbenchServer({ directory, apiToken: 'local-key' });
  await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const address = service.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function ui(path: string, body?: unknown) {
    const response = await fetch(
      url + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-be-your-agent': 'workbench' },
            body: JSON.stringify(body),
          },
    );
    const value = (await response.json()) as any;
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  return { ...service, url, ui };
}
async function waitFor<T>(read: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for test state');
}
const tool = {
  name: 'echo',
  description: 'Echo a text',
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};
const answer = {
  text: 'I will inspect two values.',
  calls: [
    { name: 'echo', arguments: { text: 'one' } },
    { name: 'echo', arguments: { text: 'two' } },
  ],
};
function input(protocol: Protocol, stream: boolean) {
  if (protocol === 'anthropic')
    return {
      model: 'human',
      max_tokens: 1024,
      stream,
      messages: [{ role: 'user', content: 'Inspect' }],
      tools: [{ name: tool.name, input_schema: tool.schema }],
    };
  if (protocol === 'chat-completions')
    return {
      model: 'human',
      stream,
      messages: [{ role: 'user', content: 'Inspect' }],
      tools: [{ type: 'function', function: { name: tool.name, parameters: tool.schema } }],
    };
  return {
    model: 'human',
    stream,
    input: 'Inspect',
    tools: [{ type: 'function', name: tool.name, parameters: tool.schema }],
  };
}

for (const protocol of ['anthropic', 'chat-completions', 'responses'] as const)
  for (const stream of [false, true]) {
    test(`${protocol}: official SDK accepts text and multiple calls, stream=${stream}`, async (t) => {
      const f = await fixture(t);
      const openai = new OpenAI({
        baseURL: f.url + '/v1',
        apiKey: 'local-key',
        maxRetries: 0,
        timeout: 10000,
      });
      const anthropic = new Anthropic({
        baseURL: f.url,
        apiKey: 'local-key',
        maxRetries: 0,
        timeout: 10000,
      });
      const inputBody = input(protocol, stream);
      const request =
        protocol === 'anthropic'
          ? anthropic.messages.create(inputBody as any)
          : protocol === 'chat-completions'
            ? openai.chat.completions.create(inputBody as any)
            : openai.responses.create(inputBody as any);
      const task = (async () => {
        const result = await request;
        if (stream) {
          const events = [];
          for await (const event of result as any) events.push(event);
          return events;
        }
        return result;
      })();
      const pending = await waitFor(() =>
        f.workbench.snapshot().requests.find((r) => r.state === 'pending'),
      );
      await f.ui(`/api/requests/${pending.id}/answer`, answer);
      const result = (await task) as any;
      if (!stream) {
        if (protocol === 'anthropic') {
          assert.equal(result.content[0].text, answer.text);
          assert.equal(result.content.filter((c: any) => c.type === 'tool_use').length, 2);
          assert.equal(result.stop_reason, 'tool_use');
        }
        if (protocol === 'chat-completions') {
          assert.equal(result.choices[0].message.tool_calls.length, 2);
          assert.equal(result.choices[0].finish_reason, 'tool_calls');
        }
        if (protocol === 'responses') {
          assert.equal(result.output.filter((c: any) => c.type === 'function_call').length, 2);
          assert.equal(result.status, 'completed');
        }
      } else {
        if (protocol === 'anthropic') {
          assert.equal(result.at(-1).type, 'message_stop');
          assert.equal(result.filter((e: any) => e.type === 'content_block_start').length, 3);
        }
        if (protocol === 'chat-completions') {
          assert.equal(result.at(-1).choices[0].finish_reason, 'tool_calls');
          assert.equal(result.filter((e: any) => e.choices[0]?.delta.tool_calls).length, 2);
        }
        if (protocol === 'responses') {
          assert.equal(result.at(-1).type, 'response.completed');
          assert.equal(
            result.filter((e: any) => e.type === 'response.function_call_arguments.done').length,
            2,
          );
        }
      }
      assert.equal(f.workbench.getRequest(pending.id).state, 'answered');
    });
  }
test('concurrent requests remain tied to their own chats and invalid answers stay pending', async (t) => {
  const f = await fixture(t);
  const chat = await f.ui('/api/chats', { name: 'Second' });
  const send = (id: string) =>
    fetch(f.url + `/chats/${id}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'local-key' },
      body: JSON.stringify(input('anthropic', false)),
    });
  const first = send('default');
  const second = send(chat.id);
  await waitFor(() => f.workbench.snapshot().requests.length === 2);
  const requests = f.workbench.snapshot().requests;
  const a = requests.find((r) => r.chatId === 'default')!;
  const b = requests.find((r) => r.chatId === chat.id)!;
  await assert.rejects(
    () => f.workbench.answer(a.id, { calls: [{ name: 'echo', arguments: { bad: true } }] }),
    /required/,
  );
  assert.equal(f.workbench.getRequest(a.id).state, 'pending');
  await f.ui(`/api/requests/${b.id}/answer`, { text: 'second' });
  assert.equal(((await (await second).json()) as any).content[0].text, 'second');
  assert.equal(f.workbench.getRequest(a.id).state, 'pending');
  await f.ui(`/api/requests/${a.id}/answer`, { text: 'first' });
  assert.equal(((await (await first).json()) as any).content[0].text, 'first');
});
test('caller disconnect and operator cancel release requests; API and local UI enforce auth', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/v1/models')).status, 401);
  assert.equal(
    (
      await fetch(f.url + '/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(f.url + '/api/state', { headers: { origin: 'https://example.com' } })).status,
    403,
  );
  const controller = new AbortController();
  const sending = fetch(f.url + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'local-key' },
    body: JSON.stringify(input('anthropic', false)),
    signal: controller.signal,
  }).catch(() => null);
  const pending = await waitFor(() =>
    f.workbench.snapshot().requests.find((r) => r.state === 'pending'),
  );
  controller.abort();
  await sending;
  await waitFor(() => f.workbench.getRequest(pending.id).state === 'cancelled');
  await assert.rejects(() => f.workbench.answer(pending.id, { text: 'late' }), /no longer pending/);
});

test('MCP stdio discovery, direct calls, saved secrets and schema errors', async (t) => {
  const f = await fixture(t);
  const saved = await f.ui('/api/mcp/save', {
    name: 'Fixture',
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixture-mcp.ts')],
    env: { TEST_SECRET: 'never-show-me' },
  });
  assert.equal(JSON.stringify(saved).includes('never-show-me'), false);
  await f.ui(`/api/mcp/${saved.id}/connect`, {});
  const connected = (await f.ui('/api/state')).mcp[0];
  assert.equal(connected.tools[0].name, 'echo');
  const result = await f.ui(`/api/mcp/${saved.id}/call`, {
    chatId: 'default',
    name: 'echo',
    arguments: { text: 'direct' },
  });
  assert.deepEqual(result.structuredContent, { echo: 'direct' });
  const entry = f.workbench.snapshot().entries.at(-1)!;
  assert.equal(entry.kind, 'tool-result');
  assert.deepEqual((entry.payload as any).arguments, { text: 'direct' });
  await assert.rejects(() => f.mcp.call(saved.id, 'echo', {}), /required/);
  await f.ui(`/api/mcp/${saved.id}/disconnect`, {});
  assert.equal((await f.ui('/api/state')).mcp[0].state, 'disconnected');
});

test('MCP Streamable HTTP authenticates with a configured bearer token', async (t) => {
  const f = await fixture(t);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const mcpServer = new Server(
    { name: 'http-fixture', version: '1' },
    { capabilities: { tools: {} } },
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', inputSchema: tool.schema }],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: String(request.params.arguments?.text) }],
  }));
  await mcpServer.connect(transport);
  let authenticated = 0;
  const remote = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer remote-token') {
      response.writeHead(401);
      response.end();
      return;
    }
    authenticated++;
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await mcpServer.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  });
  const port = (remote.address() as { port: number }).port;
  const saved = await f.mcp.save({
    name: 'Remote',
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    auth: 'bearer',
    token: 'remote-token',
  });
  await f.mcp.connect(saved.id);
  const result = await f.mcp.call(saved.id, 'echo', { text: 'authenticated' });
  assert.equal((result.content as any)[0].text, 'authenticated');
  assert.ok(authenticated >= 3);
  assert.equal(JSON.stringify(f.mcp.snapshot()).includes('remote-token'), false);
  await f.mcp.disconnect(saved.id);
});

for (const protocol of ['anthropic', 'chat-completions', 'responses'] as const) {
  test(`${protocol}: proxy streams internal MCP call, supplies its result, and returns final text`, async (t) => {
    const f = await fixture(t);
    const config = await f.mcp.save({
      name: 'Fixture',
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', resolve('tests/fixture-mcp.ts')],
    });
    await f.mcp.connect(config.id);
    const requests: any[] = [];
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const name =
        protocol === 'chat-completions' ? body.tools[0].function.name : body.tools[0].name;
      const request = parseModelRequest(protocol, { ...body, stream: true }, 'default');
      const response = modelResponse(
        request,
        requests.length === 1
          ? {
              text: 'Inspecting.',
              calls: [{ id: 'internal-call', name, arguments: { text: 'from-proxy' } }],
            }
          : { text: 'The result is from-proxy.', calls: [] },
      );
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of streamResponse(request, response)) {
        const frame =
          (event.event ? `event: ${event.event}\n` : '') +
          `data: ${event.data === '[DONE]' ? '[DONE]' : JSON.stringify(event.data)}\n\n`;
        // Split UTF-8 and event delimiters arbitrarily to exercise incremental parsing.
        const bytes = Buffer.from(frame);
        res.write(bytes.subarray(0, 7));
        res.write(bytes.subarray(7));
      }
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const port = (upstream.address() as { port: number }).port;
    await f.upstreams.save({
      protocol,
      url: `http://127.0.0.1:${port}`,
      key: 'secret',
      model: 'fixture-model',
    });
    await f.workbench.setMode('default', 'proxy');
    const path =
      protocol === 'anthropic'
        ? '/v1/messages'
        : protocol === 'chat-completions'
          ? '/v1/chat/completions'
          : '/v1/responses';
    const body = input(protocol, true);
    body.tools = [];
    const response = await fetch(f.url + '/chats/default' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-key' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(text.includes('The result is from-proxy.'));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, 'fixture-model');
    assert.ok(JSON.stringify(requests[1]).includes('from-proxy'));
    assert.ok(
      JSON.stringify(requests[1]).includes(
        protocol === 'anthropic'
          ? 'tool_result'
          : protocol === 'responses'
            ? 'function_call_output'
            : 'tool_call_id',
      ),
    );
    const state = await f.ui('/api/state');
    assert.equal(JSON.stringify(state.upstreams).includes('secret'), false);
    assert.equal(state.requests[0].state, 'answered');
    assert.equal(state.entries.filter((e: any) => e.kind === 'tool-result').length, 1);
    assert.equal(
      state.entries.filter((e: any) => e.title.startsWith('Upstream request')).length,
      2,
    );
    assert.ok(!text.includes('internal-call')); // Client never receives an MCP call it cannot execute.
  });
}
const protocols = ['anthropic', 'chat-completions', 'responses'] as const;
const routes = {
  anthropic: '/v1/messages',
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses',
};
for (const source of protocols)
  for (const target of protocols) {
    if (source === target) continue;
    test(source + ' client → ' + target + ' upstream with parallel client tools', async (t) => {
      const f = await fixture(t);
      const bodies: any[] = [];
      const upstream = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const b = JSON.parse(Buffer.concat(chunks).toString());
        bodies.push(b);
        const parsed = parseModelRequest(target, b, 'test');
        const result = modelResponse(
          parsed,
          bodies.length === 1
            ? {
                text: 'Checking',
                calls: ['a', 'b'].map((id) => ({ id, name: 'echo', arguments: { text: id } })),
              }
            : { text: 'Done', calls: [] },
        );
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result));
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
      t.after(() => new Promise<void>((r) => upstream.close(() => r())));
      const url = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
      await f.upstreams.save({ id: 'first', protocol: target, url, model: 'first' });
      await f.upstreams.save({ id: 'second', protocol: target, url, model: 'second' });
      await f.ui('/api/chats/default/upstream', { id: 'second' });
      await f.workbench.setMode('default', 'proxy');
      const payload: any = input(source, false);
      async function post() {
        const response = await fetch(f.url + '/chats/default' + routes[source], {
          method: 'POST',
          headers: { authorization: 'Bearer local-key', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 200);
        return (await response.json()) as any;
      }
      const first = await post();
      const ids = ['b', 'a'];
      if (source === 'responses') {
        assert.deepEqual(
          first.output.filter((i: any) => i.type === 'function_call').map((i: any) => i.call_id),
          ['a', 'b'],
        );
        payload.input = [
          { role: 'user', content: 'Inspect' },
          ...first.output,
          ...ids.map((call_id) => ({
            type: 'function_call_output',
            call_id,
            output: 'result-' + call_id,
          })),
        ];
      } else if (source === 'anthropic') {
        assert.deepEqual(
          first.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id),
          ['a', 'b'],
        );
        payload.messages.push(
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: ids.map((id) => ({
              type: 'tool_result',
              tool_use_id: id,
              content: 'result-' + id,
            })),
          },
        );
      } else {
        const msg = first.choices[0].message;
        assert.deepEqual(
          msg.tool_calls.map((c: any) => c.id),
          ['a', 'b'],
        );
        payload.messages.push(
          msg,
          ...ids.map((id) => ({ role: 'tool', tool_call_id: id, content: 'result-' + id })),
        );
      }
      const last = await post();
      assert.ok(JSON.stringify(last).includes('Done'));
      assert.equal(bodies[1].model, 'second');
      const outputs =
        target === 'responses'
          ? bodies[1].input
              .filter((i: any) => i.type === 'function_call_output')
              .map((i: any) => [i.call_id, i.output])
          : target === 'anthropic'
            ? bodies[1].messages.at(-1).content.map((i: any) => [i.tool_use_id, i.content])
            : bodies[1].messages
                .filter((i: any) => i.role === 'tool')
                .map((i: any) => [i.tool_call_id, i.content]);
      assert.deepEqual(
        outputs,
        ids.map((id) => [id, 'result-' + id]),
      );
      await f.ui('/api/upstreams/second/enabled', { enabled: false });
      assert.throws(() => f.upstreams.get('second'), /enabled/);
    });
  }
test('Responses proxy forks from any stored turn and never replays siblings or old instructions', async (t) => {
  const f = await fixture(t);
  const seen: any[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(body);
    const response = modelResponse(parseModelRequest('responses', body, 'upstream'), {
      text: 'reply ' + seen.length,
      calls: [],
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => upstream.close(() => r())));
  await f.upstreams.save({
    protocol: 'responses',
    url: 'http://127.0.0.1:' + (upstream.address() as { port: number }).port,
  });
  await f.workbench.setMode('default', 'proxy');
  async function post(body: any, scoped = false, extraHeaders = {}) {
    const response = await fetch(f.url + (scoped ? '/chats/default' : '') + '/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-key',
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({ model: 'test', ...body }),
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  const a = await post({ instructions: 'only first', input: 'root' }, true);
  assert.equal(a.status, 200);
  const b = await post({ input: 'second', previous_response_id: a.body.id });
  assert.equal(b.body.previous_response_id, a.body.id);
  const c = await post({ input: 'third', previous_response_id: b.body.id });
  assert.equal(c.status, 200);
  const d = await post({ input: 'sibling', previous_response_id: a.body.id, store: false });
  assert.equal(d.status, 200);
  assert.equal(seen[3].previous_response_id, undefined);
  assert.equal(seen[3].instructions, undefined);
  assert.deepEqual(seen[3].input, [
    { role: 'user', content: 'root' },
    ...a.body.output,
    { role: 'user', content: 'sibling' },
  ]);
  assert.equal(seen[2].input.length, 5);
  for (const id of ['missing', d.body.id]) {
    const e = await post({ input: 'bad', previous_response_id: id });
    assert.equal(e.status, 400);
    assert.equal(e.body.error.param, 'previous_response_id');
  }
  const conflicted = await post({ input: 'bad', previous_response_id: a.body.id }, false, {
    'x-chat-id': 'unassigned',
  });
  assert.equal(conflicted.status, 400);
  assert.equal(seen.length, 4);
});
test('unscoped requests start separate chats, and follow-ups reuse the originating chat', async (t) => {
  const f = await fixture(t);
  const a = await f.workbench.accept('anthropic', input('anthropic', false), {});
  const b = await f.workbench.accept('responses', input('responses', false), {});
  assert.notEqual(a.request.chatId, b.request.chatId);
  assert.ok(!['default', 'unassigned'].includes(a.request.chatId));
  assert.ok(!['default', 'unassigned'].includes(b.request.chatId));
  const ar = await f.workbench.answer(a.request.id, answer);
  const br = await f.workbench.answer(b.request.id, { text: 'Hello' });
  const next = await f.workbench.accept(
    'anthropic',
    {
      ...input('anthropic', false),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: ar.content.find((x: any) => x.type === 'tool_use').id,
              content: 'Done',
            },
          ],
        },
      ],
    },
    {},
  );
  const branch = await f.workbench.accept(
    'responses',
    { ...input('responses', false), previous_response_id: br.id },
    {},
  );
  assert.equal(next.request.chatId, a.request.chatId);
  assert.equal(branch.request.chatId, b.request.chatId);
});
