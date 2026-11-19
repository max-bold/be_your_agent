import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer, parseModelRequest } from '../src/protocols/requests.js';
import { modelResponse } from '../src/protocols/responses.js';
import { validateArguments } from '../src/validation.js';
const tools = [
  {
    name: 'echo',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];
const input = {
  model: 'human',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'test' }],
  tools,
};
const call = { name: 'echo', arguments: { text: 'example' } };
test('Anthropic tool choice restrictions and tool-first forced response order', () => {
  const restricted = parseModelRequest(
    'anthropic',
    { ...input, tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
    'default',
  );
  assert.throws(() => parseAnswer(restricted, { calls: [call, call] }), /only one/);
  const forced = parseModelRequest(
    'anthropic',
    { ...input, tool_choice: { type: 'tool', name: 'echo' } },
    'default',
  );
  assert.throws(() => parseAnswer(forced, { text: 'no tool' }), /requires a tool/);
  const response = modelResponse(
    forced,
    parseAnswer(forced, { text: 'Explanation after tool.', calls: [call] }),
  );
  assert.deepEqual(
    response.content.map((c: any) => c.type),
    ['tool_use', 'text'],
  );
  const none = parseModelRequest(
    'anthropic',
    { ...input, tool_choice: { type: 'none' } },
    'default',
  );
  assert.throws(() => parseAnswer(none, { calls: [call] }), /forbids/);
});
test('context pointers and unsupported server tools fail explicitly rather than silently losing context', () => {
  assert.throws(
    () =>
      parseModelRequest(
        'responses',
        { model: 'human', input: 'test', conversation: 'conv_old' },
        'default',
      ),
    /complete input/,
  );
  assert.throws(
    () =>
      parseModelRequest(
        'responses',
        { model: 'human', input: 'test', tools: [{ type: 'web_search' }] },
        'default',
      ),
    /Only function/,
  );
});
test('JSON Schema 2020-12 and nested required parameters validate without changing the data', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, selected: { type: 'boolean' } },
          required: ['key', 'selected'],
        },
      },
    },
    required: ['changes'],
  };
  const input = { changes: [{ key: 'id', selected: false }] };
  validateArguments(schema, input);
  assert.deepEqual(input, { changes: [{ key: 'id', selected: false }] });
  assert.throws(() => validateArguments(schema, { changes: [{ key: 'id' }] }), /selected/);
});
