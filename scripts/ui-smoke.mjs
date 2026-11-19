import { createWorkbenchServer } from '../src/server.js';
import { chromium } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseModelRequest } from '../src/protocols/requests.js';
import { modelResponse, streamResponse } from '../src/protocols/responses.js';
const directory = await mkdtemp(join(tmpdir(), 'be-agent-ui-'));
const service = await createWorkbenchServer({ directory });
await new Promise((r) => service.server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + service.server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const screenshot = resolve('.data/ui-smoke.png');
let upstream;
try {
  await page.goto(url);
  await page.getByText('You are the model.').waitFor();
  const pending = fetch(url + '/chats/default/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'human',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content:
            'Check Moscow and London. Explain what you are doing and call weather for each city.',
        },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Look up the weather for a city.',
          input_schema: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'The city to inspect.' },
              units: {
                type: 'string',
                enum: ['celsius', 'fahrenheit'],
                default: 'celsius',
                description: 'Temperature units.',
              },
            },
            required: ['city'],
          },
        },
      ],
    }),
  });
  await page.getByRole('button', { name: 'get_weather', exact: true }).waitFor();
  await page.locator('#response-text').fill('I will check both cities.');
  await page.getByRole('button', { name: 'get_weather', exact: true }).click();
  await page.getByLabel('city', { exact: true }).fill('Moscow');
  await page.getByRole('button', { name: 'Add to response', exact: true }).click();
  await page.getByRole('button', { name: 'get_weather', exact: true }).click();
  await page.getByLabel('city', { exact: true }).fill('London');
  await mkdir('.data', { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.getByLabel('city', { exact: true }).press('Control+Enter');
  const response = await (await pending).json();
  await page
    .locator('#tools')
    .getByRole('button', { name: 'get_weather', exact: true })
    .waitFor({ state: 'hidden' });
  await page.locator('#tool-editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#tool-count').textContent(), '0');
  assert.equal(response.content[0].text, 'I will check both cities.');
  assert.equal(response.content.filter((c) => c.type === 'tool_use').length, 2);
  assert.deepEqual(
    response.content.slice(1).map((c) => c.input.city),
    ['Moscow', 'London'],
  );
  await page.getByRole('button', { name: /MCP servers/ }).click();
  await page.getByRole('button', { name: 'Session runner preset' }).click();
  assert.ok((await page.locator('#server-args').inputValue()).includes('session_runner_mcp'));
  await page.getByRole('button', { name: '+ Add server', exact: true }).click();
  await page.locator('#server-name').fill('Fixture MCP');
  await page.locator('#server-command').fill(process.execPath);
  await page
    .locator('#server-args')
    .fill(JSON.stringify(['--import', 'tsx', resolve('tests/fixture-mcp.ts')]));
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  await page.getByLabel('Close MCP settings', { exact: true }).click();
  const group = page.getByRole('button', { name: /MCP · Fixture MCP/ });
  assert.equal(await group.getAttribute('aria-expanded'), 'false');
  await page.locator('#tool-search').fill('echo');
  await page.getByRole('button', { name: 'echo', exact: true }).waitFor();
  await page.locator('#tool-search').fill('');
  assert.equal(await group.getAttribute('aria-expanded'), 'false');
  await group.click();
  await page.getByRole('button', { name: 'echo', exact: true }).click();
  await page.getByLabel('text', { exact: true }).fill('UI round trip');
  await page.getByRole('button', { name: 'Run MCP tool', exact: true }).click();
  await page
    .locator('summary:has(.tool-result) .entry-title')
    .filter({ hasText: 'Fixture MCP / echo' })
    .waitFor();
  assert.equal(await page.getByLabel('text', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Edit models', exact: true }).click();
  await page.locator('#upstream-protocol').selectOption('responses');
  await page.locator('#upstream-url').fill('https://example.com/v1/responses');
  await page.locator('#upstream-key').fill('not-a-real-key');
  await page.getByRole('button', { name: 'Save upstream', exact: true }).click();
  await page.locator('#upstream-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '+', exact: true }).click();
  await page.locator('#chat-name').fill('Other chat');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Other chat', exact: true }).waitFor();
  let round = 0;
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    round++;
    const request = parseModelRequest('anthropic', body, 'default');
    const result = modelResponse(
      request,
      round === 1
        ? {
            text: 'Inspecting the MCP environment.',
            calls: [
              {
                id: 'ui-proxy-call',
                name: body.tools[0].name,
                arguments: { text: 'Live upstream value' },
              },
            ],
          }
        : { text: 'Inspection complete.', calls: [] },
    );
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of streamResponse(request, result)) {
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      await new Promise((r) => setTimeout(r, 120));
    }
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  await page.getByRole('button', { name: 'Edit models', exact: true }).click();
  await page.getByRole('button', { name: '+ Add model' }).click();
  await page.locator('#upstream-name').fill('Fixture model');
  await page.locator('#upstream-protocol').selectOption('anthropic');
  await page.locator('#upstream-url').fill(`http://127.0.0.1:${upstream.address().port}`);
  await page.getByRole('button', { name: 'Save upstream', exact: true }).click();
  await page.locator('#upstream-dialog').waitFor({ state: 'hidden' });
  await page.getByLabel('Upstream model', { exact: true }).selectOption({ label: 'Fixture model' });
  await page.locator('#chat-mode').selectOption('proxy');
  const chat = service.workbench.snapshot().chats.find((c) => c.name === 'Other chat');
  for (let i = 0; i < 100 && service.workbench.mode(chat.id) !== 'proxy'; i++)
    await new Promise((r) => setTimeout(r, 10));
  const proxyRequest = fetch(url + `/chats/${chat.id}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture',
      max_tokens: 1000,
      stream: true,
      messages: [{ role: 'user', content: 'Inspect the connected MCP.' }],
    }),
  });
  await page.getByLabel('text', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('#fields textarea')?.value === 'Live upstream value',
  );
  assert.equal(await page.getByLabel('text', { exact: true }).isDisabled(), true);
  await page.screenshot({ path: resolve('.data/ui-proxy-smoke.png'), fullPage: true });
  const proxyBody = await (await proxyRequest).text();
  assert.ok(proxyBody.includes('Inspection complete.'));
  assert.equal(round, 2);
  await page.getByRole('button', { name: 'API endpoints' }).click();
  await page.getByRole('heading', { name: 'API endpoints' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      screenshot,
      responseBlocks: response.content.map((c) => c.type),
      consoleErrors: errors,
    }),
  );
} finally {
  await browser.close();
  if (upstream) await new Promise((r) => upstream.close(r));
  await service.close();
  await rm(directory, { recursive: true, force: true });
}
