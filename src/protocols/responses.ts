import type { ModelAnswer, ModelRequest, JsonObject } from '../types.js';

/** Synthetic usage stays zero: a human response consumes no model tokens. */
export function modelResponse(request: ModelRequest, answer: ModelAnswer): JsonObject {
  const created = Math.floor(Date.now() / 1000);
  if (request.protocol === 'anthropic') {
    const text = answer.text ? [{ type: 'text', text: answer.text }] : [];
    const calls = answer.calls.map((c) => ({
      type: 'tool_use',
      id: c.id,
      name: c.name,
      input: c.arguments,
    }));
    return {
      id: 'msg_' + request.id.replaceAll('-', ''),
      type: 'message',
      role: 'assistant',
      model: request.model,
      content: ['any', 'tool'].includes(request.body.tool_choice?.type)
        ? [...calls, ...text]
        : [...text, ...calls],
      stop_reason: answer.calls.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  if (request.protocol === 'chat-completions')
    return {
      id: 'chatcmpl-' + request.id,
      object: 'chat.completion',
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: answer.text || null,
            ...(answer.calls.length
              ? {
                  tool_calls: answer.calls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                  })),
                }
              : {}),
          },
          logprobs: null,
          finish_reason: answer.calls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  return {
    id: 'resp_' + request.id.replaceAll('-', ''),
    object: 'response',
    created_at: created,
    status: 'completed',
    completed_at: created,
    error: null,
    incomplete_details: null,
    model: request.model,
    instructions: request.body.instructions ?? null,
    output: [
      ...(answer.text
        ? [
            {
              id: 'msg_' + request.id,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: answer.text, annotations: [], logprobs: [] }],
            },
          ]
        : []),
      ...answer.calls.map((c) => ({
        id: 'fc_' + c.id,
        type: 'function_call',
        status: 'completed',
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments),
      })),
    ],
    parallel_tool_calls: request.body.parallel_tool_calls ?? true,
    tools: request.body.tools ?? [],
    tool_choice: request.body.tool_choice ?? 'auto',
    temperature: request.body.temperature ?? 1,
    top_p: request.body.top_p ?? 1,
    max_output_tokens: request.body.max_output_tokens ?? null,
    text: request.body.text ?? { format: { type: 'text' } },
    metadata: request.body.metadata ?? {},
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    store: request.body.store ?? true,
    previous_response_id: request.body.previous_response_id ?? null,
  };
}

export interface WireEvent {
  event?: string;
  data: unknown;
}

/** Emit protocol-native lifecycle events; content is streamed after the operator submits. */
export function* streamResponse(request: ModelRequest, response: JsonObject): Generator<WireEvent> {
  if (request.protocol === 'chat-completions') {
    const choice = response.choices[0];
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
      data: {
        id: response.id,
        object: 'chat.completion.chunk',
        created: response.created,
        model: response.model,
        choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      },
    });
    yield chunk({ role: 'assistant', content: '' });
    if (choice.message.content) yield chunk({ content: choice.message.content });
    for (const [index, call] of (choice.message.tool_calls ?? []).entries())
      yield chunk({ tool_calls: [{ index, ...call }] });
    yield chunk({}, choice.finish_reason);
    if (request.body.stream_options?.include_usage)
      yield {
        data: {
          id: response.id,
          object: 'chat.completion.chunk',
          created: response.created,
          model: response.model,
          choices: [],
          usage: response.usage,
        },
      };
    yield { data: '[DONE]' };
    return;
  }
  const event = (type: string, rest: JsonObject) => ({ event: type, data: { type, ...rest } });
  if (request.protocol === 'anthropic') {
    yield event('message_start', { message: { ...response, content: [], stop_reason: null } });
    for (const [index, block] of response.content.entries()) {
      yield event('content_block_start', {
        index,
        content_block:
          block.type === 'text'
            ? { type: 'text', text: '' }
            : block.type === 'tool_use'
              ? { ...block, input: {} }
              : block,
      });
      if (block.type === 'text' || block.type === 'tool_use')
        yield event('content_block_delta', {
          index,
          delta:
            block.type === 'text'
              ? { type: 'text_delta', text: block.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
      yield event('content_block_stop', { index });
    }
    yield event('message_delta', {
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    });
    yield event('message_stop', {});
    return;
  }
  let sequence = 0;
  const responseEvent = (type: string, rest: JsonObject) =>
    event(type, { sequence_number: sequence++, ...rest });
  const initial = {
    ...response,
    status: 'in_progress',
    completed_at: null,
    output: [],
    usage: null,
  };
  yield responseEvent('response.created', { response: initial });
  yield responseEvent('response.in_progress', { response: initial });
  for (const [output_index, item] of response.output.entries()) {
    yield responseEvent('response.output_item.added', {
      output_index,
      item: {
        ...item,
        status: 'in_progress',
        ...(item.type === 'message'
          ? { content: [] }
          : item.type === 'function_call'
            ? { arguments: '' }
            : {}),
      },
    });
    const location = { item_id: item.id, output_index };
    if (item.type === 'message') {
      yield responseEvent('response.content_part.added', {
        ...location,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      });
      yield responseEvent('response.output_text.delta', {
        ...location,
        content_index: 0,
        delta: item.content[0].text,
        logprobs: [],
      });
      yield responseEvent('response.output_text.done', {
        ...location,
        content_index: 0,
        text: item.content[0].text,
        logprobs: [],
      });
      yield responseEvent('response.content_part.done', {
        ...location,
        content_index: 0,
        part: item.content[0],
      });
    } else if (item.type === 'function_call') {
      yield responseEvent('response.function_call_arguments.delta', {
        ...location,
        delta: item.arguments,
      });
      yield responseEvent('response.function_call_arguments.done', {
        ...location,
        name: item.name,
        arguments: item.arguments,
      });
    }
    yield responseEvent('response.output_item.done', { output_index, item });
  }
  yield responseEvent(
    response.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    { response },
  );
}
