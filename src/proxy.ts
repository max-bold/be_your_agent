import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { translateRequest } from './protocols/translate.js';
import { modelResponse } from './protocols/responses.js';
import { join } from 'node:path';
import { z } from 'zod';
import { JsonFile } from './storage.js';
import { InputError } from './validation.js';
import type { JsonObject, ModelRequest, Protocol } from './types.js';
import type { McpConnections } from './mcp.js';
import type { Workbench } from './workbench.js';

const schema = z
  .object({
    id: z
      .string()
      .min(1)
      .default(() => randomUUID()),
    name: z.string().trim().max(150).default(''),
    enabled: z.boolean().default(true),
    protocol: z.enum(['anthropic', 'chat-completions', 'responses']),
    url: z.string().url(),
    key: z.string().default(''),
    model: z.string().default(''),
    headers: z.record(z.string(), z.string()).default({}),
    includeMcp: z.boolean().default(true),
    maxRounds: z.number().int().min(1).max(50).default(12),
  })
  .strict();
type Config = z.infer<typeof schema>;
const masked = '••••••••';

/** Upstream settings are separate from chat history. Keys never appear in UI snapshots. */
export class Upstreams extends EventEmitter {
  private configs: Config[] = [];
  private file: JsonFile<Config[]>;
  constructor(directory: string) {
    super();
    this.file = new JsonFile(join(directory, 'upstreams.json'));
  }
  async load() {
    this.configs = (await this.file.read([])).map((c) =>
      schema.parse({ ...c, id: c.id ?? c.protocol, name: c.name || c.model || c.protocol }),
    );
  }
  snapshot() {
    return this.configs.map((c) => ({
      ...c,
      key: c.key ? masked : '',
      headers: Object.fromEntries(Object.keys(c.headers).map((k) => [k, masked])),
    }));
  }
  async save(input: unknown) {
    const config = schema.parse(input);
    config.name ||= config.model || config.protocol;
    const previous = this.configs.find((c) => c.id === config.id);
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new InputError('Use an HTTP(S) URL without credentials');
    if (config.key === masked) config.key = previous?.key ?? '';
    for (const key of Object.keys(config.headers))
      if (config.headers[key] === masked) config.headers[key] = previous?.headers[key] ?? '';
    this.configs = previous
      ? this.configs.map((c) => (c.id === config.id ? config : c))
      : [...this.configs, config];
    await this.file.write(this.configs);
    this.emit('change');
  }
  async remove(id: string) {
    if (!this.configs.some((c) => c.id === id)) throw new InputError('Unknown upstream', 404);
    this.configs = this.configs.filter((c) => c.id !== id);
    await this.file.write(this.configs);
    this.emit('change');
  }
  async enable(id: string, enabled: boolean) {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new InputError('Unknown upstream', 404);
    this.configs = this.configs.map((c) => (c.id === id ? { ...c, enabled } : c));
    await this.file.write(this.configs);
    this.emit('change');
  }
  get(id?: string) {
    const config = this.configs.find((c) => c.enabled && (!id || c.id === id));
    if (!config) throw new InputError('Select an enabled upstream model for this chat', 409);
    return config;
  }
}

interface Call {
  id: string;
  name: string;
  arguments: string;
}
interface Live {
  text: string;
  calls: Call[];
  round: number;
}
export function responseCalls(protocol: Protocol, response: JsonObject): Call[] {
  if (protocol === 'anthropic')
    return (response.content ?? [])
      .filter((c: any) => c.type === 'tool_use')
      .map((c: any) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.input) }));
  if (protocol === 'chat-completions')
    return (response.choices?.[0]?.message?.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
  return (response.output ?? [])
    .filter((c: any) => c.type === 'function_call')
    .map((c: any) => ({ id: c.call_id, name: c.name, arguments: c.arguments }));
}
export function responseText(protocol: Protocol, response: JsonObject): string {
  if (protocol === 'anthropic')
    return (response.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  if (protocol === 'chat-completions') return response.choices?.[0]?.message?.content ?? '';
  return (response.output ?? [])
    .flatMap((c: any) => (c.type === 'message' ? (c.content ?? []) : []))
    .filter((c: any) => c.type === 'output_text')
    .map((c: any) => c.text)
    .join('\n');
}

/** Assemble upstream SSE for inspection. Never expose internal MCP calls as client-owned calls. */
async function readResponse(
  response: Response,
  protocol: Protocol,
  signal: AbortSignal,
  update: (live: Live) => void,
  round: number,
): Promise<JsonObject> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  if (!response.body) throw new InputError('Upstream returned an empty stream', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: JsonObject | undefined;
  let finished = false;
  const live: Live = { text: '', calls: [], round };
  const blocks: any[] = [];
  const callMap = new Map<number, Call>();
  let lastUpdate = 0;
  const emit = (force = false) => {
    if (force || Date.now() - lastUpdate > 50) {
      update(structuredClone(live));
      lastUpdate = Date.now();
    }
  };
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          finished = true;
          continue;
        }
        const item = JSON.parse(data);
        if (item.error || item.type === 'error' || item.type === 'response.failed')
          throw new InputError(
            'Upstream reported an error. Check its configuration and request.',
            502,
          );
        if (protocol === 'chat-completions') {
          result ??= {
            id: item.id,
            object: 'chat.completion',
            created: item.created,
            model: item.model,
            choices: [
              { index: 0, message: { role: 'assistant', content: null }, finish_reason: null },
            ],
          };
          const choice = item.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === 'string') live.text += delta.content;
          for (const c of delta?.tool_calls ?? []) {
            const call = callMap.get(c.index) ?? { id: '', name: '', arguments: '' };
            if (c.id) call.id = c.id;
            call.name += c.function?.name ?? '';
            call.arguments += c.function?.arguments ?? '';
            callMap.set(c.index, call);
          }
          live.calls = [...callMap.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
          if (choice?.finish_reason) {
            result.choices[0].finish_reason = choice.finish_reason;
            finished = true;
          }
          if (item.usage) result.usage = item.usage;
        } else if (protocol === 'anthropic') {
          if (item.type === 'message_start') result = item.message;
          if (item.type === 'content_block_start') {
            blocks[item.index] = item.content_block;
            if (item.content_block.type === 'tool_use') {
              const c = item.content_block;
              callMap.set(item.index, { id: c.id, name: c.name, arguments: '' });
            }
          }
          if (item.type === 'content_block_delta') {
            if (item.delta.type === 'text_delta') {
              live.text += item.delta.text;
              blocks[item.index].text += item.delta.text;
            }
            if (item.delta.type === 'input_json_delta')
              callMap.get(item.index)!.arguments += item.delta.partial_json;
            if (item.delta.type === 'thinking_delta')
              blocks[item.index].thinking =
                (blocks[item.index].thinking ?? '') + item.delta.thinking;
            if (item.delta.type === 'signature_delta')
              blocks[item.index].signature =
                (blocks[item.index].signature ?? '') + item.delta.signature;
            if (item.delta.type === 'citations_delta')
              (blocks[item.index].citations ??= []).push(item.delta.citation);
          }
          if (item.type === 'content_block_stop' && callMap.has(item.index))
            blocks[item.index].input = JSON.parse(callMap.get(item.index)!.arguments || '{}');
          live.calls = [...callMap.values()];
          if (item.type === 'message_delta' && result) {
            Object.assign(result, item.delta);
            result.usage = { ...result.usage, ...item.usage };
          }
          if (item.type === 'message_stop') finished = true;
        } else {
          if (item.type === 'response.output_text.delta') live.text += item.delta;
          if (item.type === 'response.output_item.added' && item.item.type === 'function_call')
            callMap.set(item.output_index, {
              id: item.item.call_id,
              name: item.item.name,
              arguments: item.item.arguments ?? '',
            });
          if (item.type === 'response.function_call_arguments.delta')
            callMap.get(item.output_index)!.arguments += item.delta;
          live.calls = [...callMap.values()];
          if (['response.completed', 'response.incomplete'].includes(item.type)) {
            result = item.response;
            finished = true;
          }
        }
        emit();
      }
      if (buffer.length > 32 * 1024 * 1024)
        throw new InputError('Upstream SSE frame exceeds 32 MiB', 502);
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!finished || !result) throw new InputError('Upstream stream ended before completion', 502);
  if (protocol === 'anthropic') result.content = blocks;
  if (protocol === 'chat-completions') {
    result.choices[0].message.content = live.text || null;
    if (live.calls.length)
      result.choices[0].message.tool_calls = live.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
  }
  emit(true);
  return result;
}

export async function runProxy(
  request: ModelRequest,
  config: Config,
  mcp: McpConnections,
  workbench: Workbench,
  signal: AbortSignal,
) {
  const protocol = config.protocol;
  const tools = config.includeMcp ? mcp.proxyTools() : [];
  const incoming = translateRequest(request, protocol);
  const nativeTools = tools.map((t) =>
    protocol === 'anthropic'
      ? { name: t.name, description: t.description, input_schema: t.schema }
      : protocol === 'responses'
        ? {
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.schema,
            strict: false,
          }
        : {
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.schema,
              strict: false,
            },
          },
  );
  const originalNames = new Set(request.tools.map((t) => t.name));
  if (tools.some((t) => originalNames.has(t.name)))
    throw new InputError('Client tool name conflicts with an MCP alias');
  let input: JsonObject = {
    ...incoming,
    model: config.model || request.model,
    tools: [...(incoming.tools ?? []), ...nativeTools],
  };
  // Different executors cannot own calls in the same batch. Serialize only mixed catalogues.
  if (tools.length && request.tools.length) {
    if (protocol === 'anthropic')
      input.tool_choice = {
        ...(incoming.tool_choice ?? { type: 'auto' }),
        disable_parallel_tool_use: true,
      };
    else input.parallel_tool_calls = false;
  }
  let instructions = tools
    .map((t) => mcp.snapshot().find((c) => c.id === t.serverId)?.instructions)
    .filter(Boolean);
  instructions = [...new Set(instructions)];
  if (instructions.length) {
    const text = 'Instructions for connected MCP servers:\n' + instructions.join('\n\n');
    if (protocol === 'anthropic')
      input.system = [
        ...(typeof input.system === 'string'
          ? [{ type: 'text', text: input.system }]
          : (input.system ?? [])),
        { type: 'text', text },
      ];
    else if (protocol === 'responses')
      input.instructions = [input.instructions, text].filter(Boolean).join('\n\n');
    else input.messages = [{ role: 'system', content: text }, ...input.messages];
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...config.headers };
  if (protocol === 'anthropic') {
    headers['anthropic-version'] ??= '2023-06-01';
    if (config.key) headers['x-api-key'] = config.key;
  } else if (config.key) headers.authorization = 'Bearer ' + config.key;
  await workbench.beginProxy(request.id);
  let usage: JsonObject = {};
  for (let round = 1; round <= config.maxRounds; round++) {
    if (signal.aborted) throw new InputError('Proxy request cancelled', 409);
    await workbench.entry(
      request.chatId,
      'connection',
      `Upstream request / round ${round}`,
      {
        protocol,
        upstream: config.name,
        clientProtocol: request.protocol,
        body: input,
        mcpTools: tools.map((t) => ({ name: t.name, server: t.serverName, tool: t.toolName })),
      },
      request.id,
    );
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new InputError(
        `Upstream returned HTTP ${response.status}. Check its model, authentication and API URL.`,
        502,
      );
    }
    const result = await readResponse(
      response,
      protocol,
      signal,
      (live) => workbench.live(request.id, live),
      round,
    );
    usage = addUsage(usage, result.usage ?? {});
    const calls = responseCalls(protocol, result);
    workbench.live(request.id, { text: responseText(protocol, result), calls, round });
    await workbench.entry(
      request.chatId,
      'connection',
      `Upstream response / round ${round}`,
      result,
      request.id,
    );
    const local = calls.filter((c) => tools.some((t) => t.name === c.name));
    for (const call of calls) {
      await workbench.entry(
        request.chatId,
        'tool-call',
        config.name + ' / ' + call.name,
        {
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          executor: local.includes(call) ? 'MCP' : 'client',
        },
        request.id,
      );
    }
    if (!local.length) {
      if (protocol === request.protocol) return { ...result, usage };
      return translatedResponse(request, protocol, result, usage);
    }
    if (local.length !== calls.length)
      throw new InputError(
        'Upstream mixed MCP and client-owned tool calls in one batch despite parallel calls being disabled',
        502,
      );
    const outputs = [];
    for (const call of local) {
      const tool = tools.find((t) => t.name === call.name)!;
      let args: unknown;
      let result: any;
      const started = Date.now();
      try {
        args = JSON.parse(call.arguments);
        result = await mcp.call(tool.serverId, tool.toolName, args);
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
      await workbench.entry(
        request.chatId,
        'tool-result',
        `${tool.serverName} / ${tool.toolName}`,
        {
          serverId: tool.serverId,
          name: tool.toolName,
          arguments: args ?? call.arguments,
          durationMs: Date.now() - started,
          result,
        },
        request.id,
      );
      outputs.push({ call, result });
    }
    if (protocol === 'anthropic')
      input = {
        ...input,
        messages: [
          ...input.messages,
          { role: 'assistant', content: result.content },
          {
            role: 'user',
            content: outputs.map(({ call, result }) => ({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: result.isError === true,
              content: anthropicToolResult(result),
            })),
          },
        ],
      };
    else if (protocol === 'chat-completions')
      input = {
        ...input,
        messages: [
          ...input.messages,
          result.choices[0].message,
          ...outputs.map(({ call, result }) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          })),
        ],
      };
    else
      input = {
        ...input,
        input: [
          ...(typeof input.input === 'string'
            ? [{ role: 'user', content: input.input }]
            : input.input),
          ...result.output,
          ...outputs.map(({ call, result }) => ({
            type: 'function_call_output',
            call_id: call.id,
            output: JSON.stringify(result),
          })),
        ],
      };
  }
  throw new InputError(
    `Proxy stopped after ${config.maxRounds} model rounds. Inspect the tool loop in Inbox.`,
    502,
  );
}
function translatedResponse(
  request: ModelRequest,
  protocol: Protocol,
  result: JsonObject,
  usage: JsonObject,
) {
  const choice = result.choices?.[0];
  const reason = result.stop_reason ?? choice?.finish_reason ?? result.incomplete_details?.reason;
  const limited = ['length', 'max_tokens', 'max_output_tokens'].includes(reason);
  if (reason && !limited && !['stop', 'end_turn', 'tool_use', 'tool_calls'].includes(reason))
    throw new InputError('Cannot translate upstream completion reason ' + reason, 502);
  const blocks = protocol === 'responses' ? result.output : result.content;
  for (const block of blocks ?? []) {
    if (!['message', 'text', 'tool_use', 'function_call', 'reasoning'].includes(block.type))
      throw new InputError('Cannot translate upstream output block ' + block.type, 502);
    if (
      block.type === 'message' &&
      block.content?.some((b: JsonObject) => b.type !== 'output_text')
    )
      throw new InputError('Cannot translate upstream message content', 502);
  }
  if (choice?.message?.refusal)
    throw new InputError('Upstream refused: ' + choice.message.refusal, 502);
  const calls = responseCalls(protocol, result).map((c) => ({
    ...c,
    arguments: JSON.parse(c.arguments),
  }));
  const out = modelResponse(request, { text: responseText(protocol, result), calls });
  const cache =
    usage.cache_read_input_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0;
  const input =
    protocol === 'anthropic'
      ? (usage.input_tokens ?? 0) + cache + (usage.cache_creation_input_tokens ?? 0)
      : (usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (request.protocol === 'anthropic') {
    out.usage = {
      input_tokens: input - cache,
      cache_read_input_tokens: cache,
      output_tokens: output,
    };
    if (limited) out.stop_reason = 'max_tokens';
  } else if (request.protocol === 'responses') {
    out.usage = {
      input_tokens: input,
      input_tokens_details: { cached_tokens: cache },
      output_tokens: output,
      output_tokens_details: {
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      total_tokens: input + output,
    };
    if (limited) {
      out.status = 'incomplete';
      out.incomplete_details = { reason: 'max_output_tokens' };
      out.completed_at = null;
    }
  } else {
    out.usage = {
      prompt_tokens: input,
      prompt_tokens_details: { cached_tokens: cache },
      completion_tokens: output,
      total_tokens: input + output,
    };
    if (limited) out.choices[0].finish_reason = 'length';
  }
  return out;
}
function addUsage(total: JsonObject, value: JsonObject): JsonObject {
  const result = { ...total };
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number')
      result[key] = (typeof result[key] === 'number' ? result[key] : 0) + item;
    else if (item && typeof item === 'object' && !Array.isArray(item))
      result[key] = addUsage(result[key] ?? {}, item);
    else result[key] = item;
  }
  return result;
}
function anthropicToolResult(result: any) {
  // Preserve images as images; do not force models to read base64 inside a JSON string.
  return (result.content ?? [{ type: 'text', text: JSON.stringify(result) }]).map((content: any) =>
    content.type === 'image'
      ? {
          type: 'image',
          source: { type: 'base64', media_type: content.mimeType, data: content.data },
        }
      : content.type === 'text'
        ? content
        : { type: 'text', text: JSON.stringify(content) },
  );
}
