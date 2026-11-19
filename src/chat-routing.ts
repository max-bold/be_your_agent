import type { JsonObject, ModelRequest, Protocol } from './types.js';
import { InputError } from './validation.js';

type Turn = { request: ModelRequest; response: JsonObject };
type Hints = Record<string, unknown>;

function referenceError(message: string) {
  return new InputError(message, 400, 'previous_response_id');
}

function addToIndex<T>(index: Map<string, Set<T>>, key: unknown, value: T) {
  if (typeof key !== 'string' || !key) return;
  const values = index.get(key) ?? new Set<T>();
  values.add(value);
  index.set(key, values);
}

function resultIds(protocol: Protocol, body: JsonObject): string[] {
  const ids = new Set<string>();
  if (protocol === 'responses') {
    for (const item of Array.isArray(body.input) ? body.input : [])
      if (item?.type === 'function_call_output') ids.add(item.call_id);
  } else
    for (const message of body.messages) {
      if (protocol === 'chat-completions' && message?.role === 'tool')
        ids.add(message.tool_call_id);
      if (protocol === 'anthropic' && message?.role === 'user' && Array.isArray(message.content))
        for (const block of message.content)
          if (block?.type === 'tool_result') ids.add(block.tool_use_id);
    }
  return [...ids];
}

function inputItems(input: string | JsonObject[]): JsonObject[] {
  return typeof input === 'string' ? [{ role: 'user', content: input }] : input;
}

/** Index only replies exposed to clients. Upstream rounds and direct MCP calls are private. */
export class ChatRouting {
  private callChats = new Map<string, Set<string>>();
  private responses = new Map<string, Set<Turn>>();
  private turns = new Map<string, Turn>();

  record(request: ModelRequest, response: JsonObject) {
    if (request.protocol === 'responses') {
      if (request.body.store !== false) {
        const turn = { request, response };
        this.turns.set(request.id, turn);
        addToIndex(this.responses, response.id, turn);
      }
      for (const item of response.output ?? [])
        if (item.type === 'function_call') addToIndex(this.callChats, item.call_id, request.chatId);
    } else if (request.protocol === 'anthropic') {
      for (const block of response.content ?? [])
        if (block.type === 'tool_use') addToIndex(this.callChats, block.id, request.chatId);
    } else {
      for (const call of response.choices?.[0]?.message?.tool_calls ?? [])
        addToIndex(this.callChats, call.id, request.chatId);
    }
  }

  resolve(request: ModelRequest, hints: Hints) {
    let candidates: Set<string> | undefined;
    const sources: string[] = [];
    function constrain(chats: Set<string>, source: string) {
      candidates = candidates
        ? new Set([...candidates].filter((id) => chats.has(id)))
        : new Set(chats);
      if (!candidates.size)
        throw new InputError('Conflicting chat references: ' + [...sources, source].join(', '));
      sources.push(source);
    }
    for (const [source, id] of Object.entries(hints)) {
      if (id === undefined) continue;
      if (typeof id !== 'string' || !id)
        throw new InputError(source + ' must be a nonempty chat ID');
      constrain(new Set([id]), source);
    }
    const previous = request.protocol === 'responses' ? request.body.previous_response_id : null;
    const parents = this.responses.get(previous);
    if (previous != null) {
      if (!parents?.size) throw referenceError('Unknown previous_response_id: ' + previous);
      constrain(new Set([...parents].map((t) => t.request.chatId)), 'previous_response_id');
    }
    for (const id of resultIds(request.protocol, request.body)) {
      const chats = this.callChats.get(id);
      if (chats) constrain(chats, 'tool result ' + id);
    }
    if (parents) {
      const matches = [...parents].filter((t) => candidates?.has(t.request.chatId));
      if (matches.length !== 1) throw referenceError('Ambiguous previous_response_id: ' + previous);
      request.parentRequestId = matches[0].request.id;
    }
    return candidates?.size === 1 ? [...candidates][0] : null;
  }

  effectiveRequest(request: ModelRequest): ModelRequest {
    if (!request.parentRequestId) return request;
    const ancestors: Turn[] = [];
    let id: string | undefined = request.parentRequestId;
    while (id) {
      const turn = this.turns.get(id);
      if (!turn) throw referenceError('Previous response context is unavailable');
      ancestors.push(turn);
      id = turn.request.parentRequestId;
    }
    const input = ancestors
      .reverse()
      .flatMap(({ request, response }) => [...inputItems(request.body.input), ...response.output]);
    const body = { ...request.body };
    delete body.previous_response_id;
    body.input = input.concat(inputItems(request.body.input));
    return { ...request, body };
  }
}
