import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatRouting } from '../src/chat-routing.js';
import { parseModelRequest } from '../src/protocols/requests.js';

test('known result IDs route all protocols; ambiguity and contradictory hints differ', () => {
  const index = new ChatRouting();
  for (const chat of ['alpha', 'beta']) {
    const a = parseModelRequest(
      'anthropic',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
      chat,
    );
    index.record(a, { content: [{ type: 'tool_use', id: 'shared' }] });
    const c = parseModelRequest(
      'chat-completions',
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      chat,
    );
    index.record(c, { choices: [{ message: { tool_calls: [{ id: chat }] } }] });
  }
  const anthropic = parseModelRequest(
    'anthropic',
    {
      model: 'm',
      max_tokens: 5,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared' }] }],
    },
    '',
  );
  assert.equal(index.resolve(anthropic, {}), null);
  assert.equal(index.resolve(anthropic, { 'X-Chat-Id': 'beta' }), 'beta');
  assert.throws(() => index.resolve(anthropic, { 'X-Chat-Id': 'other' }), /Conflicting/);
  const chat = parseModelRequest(
    'chat-completions',
    { model: 'm', messages: [{ role: 'tool', tool_call_id: 'alpha', content: 'ok' }] },
    '',
  );
  assert.equal(index.resolve(chat, {}), 'alpha');
  const request = parseModelRequest('responses', { model: 'm', input: 'hello' }, 'alpha');
  index.record(request, {
    id: 'resp-a',
    output: [{ type: 'function_call', call_id: 'resp-call' }],
  });
  const result = parseModelRequest(
    'responses',
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'resp-call', output: 'ok' }] },
    '',
  );
  assert.equal(index.resolve(result, {}), 'alpha');
  assert.equal(index.resolve(request, {}), null);
  assert.throws(
    () => index.resolve(request, { 'chat URL': 'alpha', 'X-Chat-Id': 'beta' }),
    /Conflicting/,
  );
});
