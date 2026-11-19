export type Protocol = 'anthropic' | 'chat-completions' | 'responses';
export type JsonObject = Record<string, any>;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: JsonObject;
}

export interface ModelRequest {
  id: string;
  chatId: string;
  protocol: Protocol;
  model: string;
  stream: boolean;
  parentRequestId?: string;
  receivedAt: string;
  state: 'pending' | 'proxying' | 'answered' | 'cancelled';
  body: JsonObject;
  tools: ToolDefinition[];
  live?: { text: string; calls: { id: string; name: string; arguments: string }[]; round: number };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ModelAnswer {
  text: string;
  calls: ToolCall[];
}

export interface InboxEntry {
  id: string;
  chatId: string;
  at: string;
  kind: 'request' | 'response' | 'tool-result' | 'tool-call' | 'connection' | 'error';
  title: string;
  requestId?: string;
  payload: unknown;
}

export interface Chat {
  id: string;
  name: string;
  createdAt: string;
  upstreamId?: string;
  mode?: 'human' | 'proxy';
}
