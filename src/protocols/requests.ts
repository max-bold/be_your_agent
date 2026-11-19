import { randomUUID } from 'node:crypto';
import { InputError, object } from '../validation.js';
import type { JsonObject, ModelAnswer, ModelRequest, Protocol, ToolDefinition } from '../types.js';
import { validateArguments } from '../validation.js';

/** Preserve the complete original request; normalize only the fields needed by the editor. */
export function parseModelRequest(
  protocol: Protocol,
  input: unknown,
  chatId: string,
): ModelRequest {
  const body = object(input);
  if (typeof body.model !== 'string' || !body.model.trim())
    throw new InputError('model is required');
  if (body.stream !== undefined && typeof body.stream !== 'boolean')
    throw new InputError('stream must be boolean');
  if (protocol === 'responses') {
    if (body.conversation != null)
      throw new InputError(
        'Send complete input or previous_response_id; conversation is not supported',
      );
    if (
      body.previous_response_id != null &&
      (typeof body.previous_response_id !== 'string' || !body.previous_response_id)
    )
      throw new InputError(
        'previous_response_id must be a nonempty string',
        400,
        'previous_response_id',
      );
    if (!(typeof body.input === 'string' || Array.isArray(body.input)))
      throw new InputError('input must be text or an array');
  } else if (!Array.isArray(body.messages) || !body.messages.length)
    throw new InputError('messages must be a nonempty array');
  if (protocol === 'anthropic' && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1))
    throw new InputError('max_tokens must be a positive integer');
  if (body.n !== undefined && body.n !== 1) throw new InputError('Only n=1 is supported');
  if (body.background === true) throw new InputError('background responses are not supported');
  if (body.tools !== undefined && !Array.isArray(body.tools))
    throw new InputError('tools must be an array');
  const tools: ToolDefinition[] = (body.tools ?? []).map((item: JsonObject) => {
    object(item, 'Tool');
    if (protocol === 'anthropic') {
      if (item.type && item.type !== 'custom')
        throw new InputError('Only client-defined function tools are supported');
      return tool(item.name, item.description, item.input_schema);
    }
    if (item.type !== 'function') throw new InputError('Only function tools are supported');
    const definition = protocol === 'chat-completions' ? object(item.function, 'function') : item;
    return tool(
      definition.name,
      definition.description,
      definition.parameters ?? { type: 'object' },
    );
  });
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new InputError('Tool names must be unique');
  return {
    id: randomUUID(),
    chatId,
    protocol,
    model: body.model,
    stream: body.stream === true,
    receivedAt: new Date().toISOString(),
    state: 'pending',
    body,
    tools,
  };
}

function tool(name: unknown, description: unknown, schema: unknown): ToolDefinition {
  if (typeof name !== 'string' || !name) throw new InputError('Tool name is required');
  return {
    name,
    description: typeof description === 'string' ? description : '',
    schema: object(schema, 'Tool schema'),
  };
}

export function parseAnswer(request: ModelRequest, input: unknown): ModelAnswer {
  const value = object(input);
  const text = value.text ?? '';
  if (typeof text !== 'string' || !Array.isArray(value.calls ?? []))
    throw new InputError('Expected text and calls array');
  if (text.length > 2_000_000 || (value.calls?.length ?? 0) > 50)
    throw new InputError('Answer is too large');
  const calls = (value.calls ?? []).map((value: unknown) => {
    const call = object(value, 'Tool call');
    const definition = request.tools.find((t) => t.name === call.name);
    if (!definition) throw new InputError(`Tool is not available in this request: ${call.name}`);
    validateArguments(definition.schema, call.arguments);
    return {
      id: 'call_' + randomUUID().replaceAll('-', ''),
      name: definition.name,
      arguments: call.arguments,
    };
  });
  if (!text.trim() && !calls.length)
    throw new InputError('Add a text response or at least one tool call');
  const choice = request.body.tool_choice;
  const mode = typeof choice === 'string' ? choice : choice?.type;
  if (mode === 'none' && calls.length) throw new InputError('This request forbids tool calls');
  if (['required', 'any', 'tool', 'function'].includes(mode) && !calls.length)
    throw new InputError('This request requires a tool call');
  const forced =
    choice?.function?.name ?? (['tool', 'function'].includes(mode) ? choice?.name : undefined);
  if (forced && calls.some((c: { name: string }) => c.name !== forced))
    throw new InputError(`This request requires tool: ${forced}`);
  if (
    (request.body.parallel_tool_calls === false || choice?.disable_parallel_tool_use === true) &&
    calls.length > 1
  )
    throw new InputError('This request permits only one tool call');
  return { text, calls };
}
