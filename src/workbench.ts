import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { JsonFile } from './storage.js';
import { ChatRouting } from './chat-routing.js';
import { InputError } from './validation.js';
import { parseAnswer, parseModelRequest } from './protocols/requests.js';
import { modelResponse } from './protocols/responses.js';
import type { Chat, InboxEntry, ModelRequest, Protocol, JsonObject } from './types.js';

interface History {
  chats: Chat[];
  requests: ModelRequest[];
  entries: InboxEntry[];
}
interface WaitingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
}

function chatTitle(request: ModelRequest) {
  const messages = request.body.messages ?? request.body.input;
  const content =
    typeof messages === 'string'
      ? messages
      : messages.find((item: JsonObject) => item?.role === 'user')?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find((part) => typeof part?.text === 'string')?.text
        : '';
  return text?.trim().replace(/\s+/g, ' ') || request.protocol + ' request';
}

/** Each HTTP request has its own waiter. Selecting another chat never changes its destination. */
export class Workbench extends EventEmitter {
  private history: History = { chats: [], requests: [], entries: [] };
  readonly routing = new ChatRouting();
  private pending = new Map<string, WaitingRequest>();
  private file: JsonFile<History>;
  constructor(directory: string) {
    super();
    this.file = new JsonFile(join(directory, 'history.json'));
  }

  async load() {
    this.history = await this.file.read(this.history);
    for (const request of this.history.requests)
      if (['pending', 'proxying'].includes(request.state)) request.state = 'cancelled';
    if (!this.history.chats.length) this.addChat('Workbench', 'default');
    const requests = new Map(this.history.requests.map((r) => [r.id, r]));
    for (const e of this.history.entries) {
      const request = e.requestId && requests.get(e.requestId);
      if (e.kind === 'response' && request && request.state === 'answered')
        this.routing.record(request, e.payload as JsonObject);
    }
    await this.save();
  }

  snapshot() {
    return structuredClone(this.history);
  }
  getRequest(id: string) {
    const request = this.history.requests.find((r) => r.id === id);
    if (!request) throw new InputError('Request not found', 404);
    return request;
  }
  hasChat(id: string) {
    return this.history.chats.some((c) => c.id === id);
  }
  upstreamId(id: string) {
    return this.history.chats.find((c) => c.id === id)?.upstreamId;
  }
  async setUpstream(id: string, upstreamId: string) {
    const chat = this.history.chats.find((c) => c.id === id);
    if (!chat) throw new InputError('Unknown chat', 404);
    chat.upstreamId = upstreamId;
    await this.save();
  }
  mode(id: string) {
    return this.history.chats.find((c) => c.id === id)?.mode ?? 'human';
  }
  async setMode(id: string, mode: 'human' | 'proxy') {
    const chat = this.history.chats.find((c) => c.id === id);
    if (!chat) throw new InputError('Chat not found', 404);
    chat.mode = mode;
    await this.save();
  }
  live(id: string, live: ModelRequest['live']) {
    const request = this.getRequest(id);
    request.live = live;
    this.emit('live', { id, live });
  }
  async beginProxy(id: string) {
    this.getRequest(id).state = 'proxying';
    await this.save();
  }
  async finishProxy(id: string, response: JsonObject) {
    const request = this.getRequest(id);
    if (!this.pending.has(id)) throw new InputError('Request was cancelled', 409);
    const waiting = this.pending.get(id)!;
    this.pending.delete(id);
    request.state = 'answered';
    if (request.protocol === 'responses') {
      response.previous_response_id = request.body.previous_response_id ?? null;
      response.store = request.body.store ?? true;
    }
    try {
      await this.entry(
        request.chatId,
        'response',
        `${request.protocol} / proxy response`,
        response,
        id,
      );
      this.routing.record(request, response);
      waiting.resolve(response);
    } catch (error) {
      request.state = 'cancelled';
      waiting.reject(new Error('Could not save proxy response'));
      throw error;
    }
  }
  addChat(name: string, id: string = randomUUID()) {
    const chat = {
      id,
      name: name.trim().slice(0, 100) || 'Untitled chat',
      createdAt: new Date().toISOString(),
    };
    this.history.chats.push(chat);
    return chat;
  }
  async createChat(name: string) {
    const chat = this.addChat(name);
    await this.save();
    return chat;
  }
  async renameChat(id: string, name: string) {
    const chat = this.history.chats.find((c) => c.id === id);
    if (!chat) throw new InputError('Chat not found', 404);
    chat.name = name.trim().slice(0, 100) || 'Untitled chat';
    await this.save();
    return chat;
  }
  async entry(
    chatId: string,
    kind: InboxEntry['kind'],
    title: string,
    payload: unknown,
    requestId?: string,
  ) {
    if (!this.hasChat(chatId)) throw new InputError('Chat not found', 404);
    const entry = {
      id: randomUUID(),
      chatId,
      at: new Date().toISOString(),
      kind,
      title,
      payload,
      requestId,
    };
    this.history.entries.push(entry);
    await this.save();
    return entry;
  }
  async accept(protocol: Protocol, body: unknown, hints: Record<string, unknown>) {
    const request = parseModelRequest(protocol, body, '');
    const resolved = this.routing.resolve(request, hints);
    const chatId = resolved ?? this.addChat(chatTitle(request)).id;
    if (!this.hasChat(chatId))
      throw new InputError('Unknown chat. Create it in the workbench first.', 404);
    request.chatId = chatId;
    this.history.requests.push(request);
    let resolve!: WaitingRequest['resolve'];
    let reject!: WaitingRequest['reject'];
    const answer = new Promise<JsonObject>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // The HTTP handler may not yet have attached its await when persistence fails.
    void answer.catch(() => {});
    this.pending.set(request.id, { resolve, reject });
    try {
      await this.entry(
        chatId,
        'request',
        `${protocol} / ${request.model}`,
        request.body,
        request.id,
      );
    } catch (error) {
      this.pending.delete(request.id);
      request.state = 'cancelled';
      throw error;
    }
    return { request, answer };
  }
  async answer(id: string, input: unknown) {
    const request = this.getRequest(id);
    const waiting = this.pending.get(id);
    if (!waiting || request.state !== 'pending')
      throw new InputError('Request is no longer pending', 409);
    const answer = parseAnswer(request, input);
    const response = modelResponse(request, answer);
    // Remove before awaiting disk: a double click can never resolve a request twice.
    this.pending.delete(id);
    request.state = 'answered';
    try {
      for (const call of answer.calls)
        await this.entry(request.chatId, 'tool-call', 'Human / ' + call.name, call, id);
      await this.entry(request.chatId, 'response', `${request.protocol} / response`, response, id);
      this.routing.record(request, response);
      waiting.resolve(response);
    } catch (error) {
      request.state = 'cancelled';
      waiting.reject(new Error('Could not save the response'));
      throw error;
    }
    return response;
  }
  async cancel(id: string, reason: string, error: Error = new InputError(reason, 409)) {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    const request = this.getRequest(id);
    this.pending.delete(id);
    request.state = 'cancelled';
    waiting.reject(error);
    await this.entry(request.chatId, 'error', 'Request cancelled', { reason }, id);
  }
  async close() {
    await Promise.all(
      [...this.pending.keys()].map((id) => this.cancel(id, 'Workbench is shutting down')),
    );
  }
  private async save() {
    await this.file.write(this.history);
    this.emit('change');
  }
}
