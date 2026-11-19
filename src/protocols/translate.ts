import { InputError } from '../validation.js';
import type { ModelRequest, JsonObject, Protocol } from '../types.js';

function unsupported(field: string): never {
  throw new InputError('Cannot translate ' + field + ' between these API formats.');
}

function textContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return unsupported('message content');
  return content
    .map((block) => {
      if (
        !['text', 'input_text', 'output_text'].includes(block.type) ||
        typeof block.text !== 'string'
      )
        return unsupported('content block ' + block.type);
      return block.text;
    })
    .join('');
}

// Keep calls and their outputs as individual items so parallel calls retain their IDs.
function history(body: JsonObject): { instructions: string; items: JsonObject[] } {
  const system: string[] = [];
  if (body.system || body.instructions) system.push(textContent(body.system ?? body.instructions));
  const items: JsonObject[] = [];
  const messages =
    body.messages ??
    (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input);
  for (const m of messages) {
    if (m.type === 'function_call' || m.type === 'function_call_output') {
      items.push(m);
      continue;
    }
    if (['system', 'developer'].includes(m.role)) {
      system.push(textContent(m.content));
      continue;
    }
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: textContent(m.content),
      });
      continue;
    }
    if (!['assistant', 'user'].includes(m.role)) unsupported('input item ' + (m.type ?? m.role));
    if (typeof m.content === 'string') items.push({ role: m.role, content: m.content });
    else
      for (const b of m.content ?? []) {
        if (b.type === 'tool_use')
          items.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input),
          });
        else if (b.type === 'tool_result') {
          const output = textContent(b.content ?? '');
          items.push({
            type: 'function_call_output',
            call_id: b.tool_use_id,
            output: b.is_error ? JSON.stringify({ isError: true, content: output }) : output,
          });
        } else items.push({ role: m.role, content: textContent([b]) });
      }
    for (const c of m.tool_calls ?? [])
      items.push({
        type: 'function_call',
        call_id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      });
  }
  return { instructions: system.join('\n\n'), items };
}

function messagesFor(items: JsonObject[], protocol: Protocol) {
  const messages: JsonObject[] = [];
  for (const i of items) {
    const prev = messages.at(-1);
    if (protocol === 'anthropic') {
      let role = i.role;
      let block: JsonObject;
      if (i.type === 'function_call') {
        role = 'assistant';
        block = { type: 'tool_use', id: i.call_id, name: i.name, input: JSON.parse(i.arguments) };
      } else if (i.type === 'function_call_output') {
        role = 'user';
        block = { type: 'tool_result', tool_use_id: i.call_id, content: textContent(i.output) };
      } else block = { type: 'text', text: i.content };
      if (prev?.role === role && prev) prev.content.push(block);
      else messages.push({ role, content: [block] });
    } else if (i.type === 'function_call') {
      const message = prev?.role === 'assistant' ? prev : { role: 'assistant', content: null };
      if (message !== prev) messages.push(message);
      (message.tool_calls ??= []).push({
        type: 'function',
        id: i.call_id,
        function: { name: i.name, arguments: i.arguments },
      });
    } else if (i.type === 'function_call_output')
      messages.push({ role: 'tool', tool_call_id: i.call_id, content: textContent(i.output) });
    else messages.push(i);
  }
  return messages;
}

export function translateRequest(request: ModelRequest, target: Protocol): JsonObject {
  const b = request.body;
  if (request.protocol === target) return structuredClone(b);
  const supported = new Set(
    'model stream messages input instructions system tools tool_choice max_tokens max_completion_tokens max_output_tokens parallel_tool_calls temperature top_p metadata stream_options n store'.split(
      ' ',
    ),
  );
  for (const field of Object.keys(b))
    if (!supported.has(field) && b[field] != null) unsupported(field);
  const { instructions, items } = history(b);
  const out: JsonObject = { model: b.model, stream: request.stream };
  for (const key of ['temperature', 'top_p']) if (b[key] != null) out[key] = b[key];
  const limit = b.max_tokens ?? b.max_completion_tokens ?? b.max_output_tokens;
  if (target === 'responses') {
    out.input = items;
    if (instructions) out.instructions = instructions;
    if (limit) out.max_output_tokens = limit;
    out.store = false;
  } else {
    out.messages = messagesFor(items, target);
    if (target === 'anthropic') {
      if (instructions) out.system = instructions;
      out.max_tokens = limit ?? 4096;
    } else {
      if (instructions) out.messages.unshift({ role: 'system', content: instructions });
      if (limit) out.max_completion_tokens = limit;
      if (request.stream) out.stream_options = { include_usage: true };
    }
  }
  out.tools = request.tools.map(({ name, description, schema }, index) => {
    const original = b.tools[index].function ?? b.tools[index];
    for (const field of Object.keys(original))
      if (!['type', 'name', 'description', 'parameters', 'input_schema', 'strict'].includes(field))
        unsupported('tools[].' + field);
    if (target === 'anthropic')
      return {
        name,
        description,
        input_schema: schema,
        ...(original.strict ? { strict: true } : {}),
      };
    const fn = { name, description, parameters: schema, strict: original.strict ?? false };
    return target === 'responses'
      ? { type: 'function', ...fn }
      : { type: 'function', function: fn };
  });
  const choice = b.tool_choice;
  const mode = typeof choice === 'string' ? choice : choice?.type;
  const name = choice?.function?.name ?? choice?.name;
  const parallel =
    b.parallel_tool_calls ??
    (choice?.disable_parallel_tool_use === undefined
      ? undefined
      : !choice.disable_parallel_tool_use);
  if (mode && !['auto', 'none', 'any', 'required', 'tool', 'function'].includes(mode))
    unsupported('tool_choice.' + mode);
  if (target === 'anthropic') {
    if (mode || parallel !== undefined)
      out.tool_choice = {
        type: name ? 'tool' : mode === 'required' ? 'any' : (mode ?? 'auto'),
        ...(name ? { name } : {}),
        ...(parallel === undefined ? {} : { disable_parallel_tool_use: !parallel }),
      };
  } else {
    if (mode)
      out.tool_choice = name
        ? target === 'responses'
          ? { type: 'function', name }
          : { type: 'function', function: { name } }
        : mode === 'any'
          ? 'required'
          : mode;
    if (parallel !== undefined) out.parallel_tool_calls = parallel;
  }
  return out;
}
