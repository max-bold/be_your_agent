import { createSchemaEditor } from './schema.js';
import {
  element,
  jsonView,
  renderRequest,
  renderResponse,
  renderToolResult,
  rawDetails,
} from './content.js';
import { setupSettings, showEndpoints, showInfo } from './settings.js';

const $ = (id) => document.getElementById(id);
let state = { chats: [], requests: [], entries: [], mcp: [], upstreams: [] };
let chatId = localStorage.getItem('active-chat') ?? 'default';
let requestId;
let selection;
let schemaEditor;
let tab = 'fields';
let filter = 'all';
let feedSignature = '';
let toolsSignature = '';
let selectedCallIndex = null;
let submitting = false;
let requestSignature = '';
const drafts = new Map();
const formDrafts = new Map();

export async function api(path, value) {
  const response = await fetch(
    path,
    value === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-be-your-agent': 'workbench' },
          body: JSON.stringify(value),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? result.error ?? 'Request failed');
  return result;
}
function status(message) {
  $('status').textContent = message;
}
function error(message) {
  $('editor-error').textContent = message;
  status(message || 'Ready');
}
function currentRequest() {
  return state.requests.find((r) => r.id === requestId && r.chatId === chatId);
}
function draft() {
  const key = requestId ?? 'none:' + chatId;
  if (!drafts.has(key)) drafts.set(key, { text: '', calls: [] });
  return drafts.get(key);
}
function pending(request) {
  return request && ['pending', 'proxying'].includes(request.state);
}
function switchChat(id) {
  saveForm();
  chatId = id;
  localStorage.setItem('active-chat', id);
  requestId = undefined;
  selection = undefined;
  selectedCallIndex = null;
  feedSignature = '';
  toolsSignature = '';
  requestSignature = '';
  render();
}
function saveForm() {
  if (!selection || selection.source === 'proxy') return;
  try {
    formDrafts.set(selection.key, readArguments());
  } catch {
    /* Keep invalid JSON visible until corrected. */
  }
}
function readArguments() {
  if (tab === 'json') return JSON.parse($('arguments-json').value);
  return schemaEditor?.read() ?? {};
}
function renderChats() {
  $('chats').replaceChildren();
  for (const chat of state.chats) {
    const button = element('button', 'chat' + (chat.id === chatId ? ' active' : ''));
    const count = state.requests.filter((r) => r.chatId === chat.id && pending(r)).length;
    button.append(element('span', '', chat.name));
    if (count) button.append(element('span', 'pending-count', count));
    button.onclick = () => switchChat(chat.id);
    $('chats').append(button);
  }
  const chat = state.chats.find((c) => c.id === chatId);
  $('chat-mode').value = chat?.mode ?? 'human';
  const select = $('active-upstream');
  const models = state.upstreams.filter((c) => c.enabled);
  const chosen = chat?.upstreamId ?? models[0]?.id;
  select.replaceChildren(...models.map((c) => new Option(c.name, c.id)));
  if (!models.some((c) => c.id === chosen))
    select.prepend(new Option(models.length ? 'Select model' : 'No enabled models', ''));
  select.value = chosen && models.some((c) => c.id === chosen) ? chosen : '';
  select.disabled = !models.length;
}
function renderRequests() {
  const requests = state.requests.filter((r) => r.chatId === chatId);
  const waiting = requests.find((r) => pending(r));
  if (waiting && !pending(requests.find((r) => r.id === requestId))) {
    saveForm();
    requestId = waiting.id;
    selection = undefined;
    selectedCallIndex = null;
    renderEditor();
    toolsSignature = '';
  }
  if (!requests.some((r) => r.id === requestId))
    requestId = requests.findLast((r) => pending(r))?.id ?? requests.at(-1)?.id;
  const signature = JSON.stringify(requests.map((r) => [r.id, r.state]));
  if (signature !== requestSignature) {
    $('pending-request').replaceChildren();
    if (!requests.length) $('pending-request').add(new Option('No API requests yet', ''));
    for (const request of [...requests].reverse())
      $('pending-request').add(
        new Option(
          `${request.state} · ${request.protocol} · ${request.id.slice(0, 8)}`,
          request.id,
        ),
      );
    requestSignature = signature;
  }
  $('pending-request').value = requestId ?? '';
  const request = currentRequest();
  $('cancel-request').disabled = !pending(request);
  const manual = request?.state === 'pending';
  if (!manual && selection?.source === 'request') {
    selection = undefined;
    selectedCallIndex = null;
    renderEditor();
  }
  $('send-response').disabled = !manual || submitting;
  $('preview-response').disabled = !manual || submitting;
  $('response-text').readOnly = !manual;
  const value = request?.live && request.state !== 'pending' ? request.live.text : draft().text;
  if ($('response-text').value !== value) $('response-text').value = value;
  $('response-target').textContent = request
    ? `${request.protocol} · ${request.state} · ${request.id.slice(0, 8)}`
    : 'Waiting for API request';
  renderDraftCalls();
}
function renderDraftCalls() {
  const request = currentRequest();
  const calls = request?.live && request.state !== 'pending' ? request.live.calls : draft().calls;
  $('draft-summary').textContent =
    `${calls.length} tool call${calls.length === 1 ? '' : 's'}${request?.live && request.state !== 'pending' ? ` · upstream round ${request.live.round}` : ''}`;
  $('draft-calls').replaceChildren();
  for (const [index, call] of calls.entries()) {
    const row = element('div', 'draft-call');
    const edit = element('button', '', `${index + 1}. ${call.name}`);
    edit.onclick = () => {
      if (request?.state === 'pending') {
        const definition = request.tools.find((t) => t.name === call.name);
        if (!definition) return;
        chooseTool(
          { ...definition, source: 'request', key: `request:${request.id}:${call.name}` },
          call.arguments,
          index,
        );
      } else {
        selectedCallIndex = index;
        renderLive(true);
      }
    };
    row.append(edit);
    if (request?.state === 'pending') {
      const remove = element('button', '', '×');
      remove.title = 'Remove call';
      remove.onclick = () => {
        draft().calls.splice(index, 1);
        selectedCallIndex = null;
        renderDraftCalls();
      };
      row.append(remove);
    }
    $('draft-calls').append(row);
  }
}
function renderTools() {
  const request = currentRequest();
  const query = $('tool-search').value.trim().toLowerCase();
  const signature = JSON.stringify([
    query,
    requestId,
    request?.state,
    selection?.key,
    state.mcp.map((s) => [s.id, s.name, s.state, s.tools]),
  ]);
  if (signature === toolsSignature) return;
  toolsSignature = signature;
  const list = $('tools');
  list.replaceChildren();
  let count = 0;
  function group(name, tools, source, server) {
    const filtered = tools.filter((t) =>
      (t.name + ' ' + (t.description ?? '')).toLowerCase().includes(query),
    );
    if (server && query && !filtered.length) return;
    const title = element('div', 'group-title', server ? '' : name);
    list.append(title);
    let items = list;
    if (server) {
      const preference = 'expanded-mcp:' + server.id;
      items = element('div');
      items.id = 'tools-' + server.id;
      const toggle = element('button', 'group-toggle', name + ' (' + filtered.length + ')');
      toggle.setAttribute('aria-controls', items.id);
      function setExpanded(expanded) {
        items.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
      }
      setExpanded(Boolean(query) || localStorage.getItem(preference) === 'true');
      toggle.onclick = () => {
        const expanded = items.hidden;
        setExpanded(expanded);
        if (!query) localStorage.setItem(preference, String(expanded));
      };
      title.append(toggle);
      list.append(items);
      const refresh = element('button', '', '↻');
      refresh.title = 'Refresh MCP tools';
      refresh.onclick = async () => {
        try {
          await api(`/api/mcp/${server.id}/refresh`, {});
          await refreshState();
        } catch (e) {
          error(e.message);
        }
      };
      title.append(refresh);
    }
    for (const tool of filtered) {
      count++;
      const key =
        source === 'request'
          ? `request:${requestId}:${tool.name}`
          : `mcp:${server.id}:${tool.name}`;
      const button = element(
        'button',
        'tool' + (selection?.key === key ? ' active' : ''),
        tool.name,
      );
      button.title = tool.description ?? '';
      button.onclick = () =>
        chooseTool({
          name: tool.name,
          description: tool.description ?? '',
          schema: tool.schema ?? tool.inputSchema,
          source,
          serverId: server?.id,
          serverName: server?.name,
          key,
        });
      items.append(button);
    }
    if (!filtered.length)
      items.append(
        element(
          'p',
          'empty-note',
          query ? 'No matching tools' : server ? 'No tools available' : 'No tools in this request',
        ),
      );
  }
  if (request?.state === 'pending')
    group('Request tools · return a tool call', request.tools, 'request');
  else if (!request)
    list.append(element('p', 'empty-note', 'API requests bring their own tool definitions.'));
  for (const server of state.mcp) {
    if (server.state === 'connected') group('MCP · ' + server.name, server.tools, 'mcp', server);
    else {
      const title = element('div', 'group-title', server.name + ' · ' + server.state);
      list.append(title);
    }
  }
  if (!state.mcp.length)
    list.append(
      element(
        'p',
        'empty-note',
        'Connect MCP servers from the top bar to call their tools directly.',
      ),
    );
  $('tool-count').textContent = String(count);
  if (query && !count && request?.state !== 'pending')
    list.append(element('p', 'empty-note', 'No matching tools'));
}
function chooseTool(tool, args, editingIndex = null) {
  saveForm();
  selection = tool;
  selectedCallIndex = editingIndex;
  error('');
  tab = 'fields';
  renderEditor(args ?? formDrafts.get(tool.key) ?? {});
  toolsSignature = '';
  renderTools();
}
function renderEditor(args = {}) {
  $('tool-empty').hidden = Boolean(selection);
  $('tool-editor').hidden = !selection;
  if (!selection) {
    $('editor-source').textContent = 'Select a tool';
    return;
  }
  $('tool-name').textContent = selection.name;
  $('tool-description').textContent = selection.description;
  $('source-badge').textContent =
    selection.source === 'mcp'
      ? 'MCP · execute now'
      : selection.source === 'proxy'
        ? 'UPSTREAM · live'
        : 'MODEL · draft call';
  $('editor-source').textContent =
    selection.serverName ??
    (selection.source === 'proxy' ? 'Read-only upstream output' : 'Client-defined tool');
  $('arguments-json').value = JSON.stringify(args, null, 2);
  schemaEditor = createSchemaEditor($('fields'), selection.schema, args, () => {});
  $('schema-json').textContent = JSON.stringify(selection.schema, null, 2);
  $('run-tool').textContent =
    selection.source === 'mcp'
      ? 'Run MCP tool'
      : selectedCallIndex === null
        ? 'Add to response'
        : 'Update call';
  $('run-tool').disabled =
    selection.source === 'proxy' ||
    (selection.source === 'request' && currentRequest()?.state !== 'pending');
  $('tool-hint').textContent =
    selection.source === 'mcp'
      ? 'Executes immediately. Result appears in Inbox.'
      : selection.source === 'proxy'
        ? 'Arguments are being received from the upstream model.'
        : 'Draft only. Send the complete response when ready.';
  if (selection.source === 'proxy')
    for (const input of $('fields').querySelectorAll('input,textarea,select,button'))
      input.disabled = true;
  updateTab();
}
function updateTab() {
  for (const name of ['fields', 'json', 'schema'])
    $(name + '-tab').setAttribute('aria-pressed', String(tab === name));
  $('fields').hidden = tab !== 'fields';
  $('arguments-json').hidden = tab !== 'json';
  $('schema-json').hidden = tab !== 'schema';
  $('arguments-json').readOnly = selection?.source === 'proxy';
}
for (const name of ['fields', 'json', 'schema'])
  $(name + '-tab').onclick = () => {
    if (name === tab) return;
    try {
      const args = readArguments();
      tab = name;
      schemaEditor = createSchemaEditor($('fields'), selection.schema, args);
      if (name === 'json') $('arguments-json').value = JSON.stringify(args, null, 2);
      updateTab();
      error('');
    } catch (e) {
      error(e.message);
    }
  };
function stageCall() {
  if (selection?.source !== 'request') return;
  if (currentRequest()?.state !== 'pending')
    throw new Error('This request is no longer waiting for a human response');
  const args = readArguments();
  const call = { name: selection.name, arguments: args };
  if (selectedCallIndex !== null) draft().calls[selectedCallIndex] = call;
  else draft().calls.push(call);
  formDrafts.delete(selection.key);
  selection = undefined;
  selectedCallIndex = null;
  renderEditor();
  renderDraftCalls();
  toolsSignature = '';
  renderTools();
}
$('tool-form').onsubmit = async (event) => {
  event.preventDefault();
  error('');
  if (selection?.source !== 'mcp') {
    try {
      stageCall();
      status('Tool call added to response');
    } catch (e) {
      error(e.message);
    }
    return;
  }
  const selected = selection;
  const target = chatId;
  const button = $('run-tool');
  button.disabled = true;
  try {
    const args = readArguments();
    status('Running ' + selected.name + '…');
    await api(`/api/mcp/${selected.serverId}/call`, {
      name: selected.name,
      arguments: args,
      chatId: target,
    });
    formDrafts.delete(selected.key);
    if (selection?.key === selected.key) renderEditor({});
    await refreshState();
    status('MCP tool finished');
  } catch (e) {
    error(e.message);
  } finally {
    button.disabled = false;
  }
};
async function answer(preview = false) {
  if (submitting) return;
  const request = currentRequest();
  if (request?.state !== 'pending') return;
  try {
    error('');
    stageCall();
    const value = { text: draft().text, calls: draft().calls };
    submitting = true;
    renderRequests();
    const result = await api(
      `/api/requests/${request.id}/${preview ? 'preview' : 'answer'}`,
      value,
    );
    if (preview) showInfo('Model response · wire JSON', jsonView(result));
    else {
      drafts.delete(request.id);
      selection = undefined;
      selectedCallIndex = null;
      renderEditor();
      await refreshState();
      status('Response sent');
    }
  } catch (e) {
    error(e.message);
  } finally {
    submitting = false;
    renderRequests();
  }
}
$('send-response').onclick = () => answer();
$('preview-response').onclick = () => answer(true);
$('response-text').addEventListener('input', () => {
  draft().text = $('response-text').value;
});
$('pending-request').onchange = () => {
  saveForm();
  requestId = $('pending-request').value;
  selection = undefined;
  selectedCallIndex = null;
  renderEditor();
  toolsSignature = '';
  render();
};
$('cancel-request').onclick = async () => {
  try {
    await api(`/api/requests/${requestId}/cancel`, {});
    await refreshState();
  } catch (e) {
    error(e.message);
  }
};
$('tool-search').oninput = () => {
  toolsSignature = '';
  renderTools();
};
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.ctrlKey || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (selection?.source === 'mcp' && $('tool-editor').contains(document.activeElement))
    $('tool-form').requestSubmit();
  else void answer();
});

function renderLive(force = false) {
  const request = currentRequest();
  if (!request?.live || request.state === 'pending' || selection?.source === 'mcp') return;
  const calls = request.live.calls;
  if (!calls.length) return;
  const index =
    selectedCallIndex === null ? calls.length - 1 : Math.min(selectedCallIndex, calls.length - 1);
  const call = calls[index];
  const upstream = state.entries.findLast(
    (e) => e.requestId === request.id && e.title.startsWith('Upstream request'),
  );
  const tool = (upstream?.payload.body?.tools ?? []).find(
    (t) => (t.function?.name ?? t.name) === call.name,
  );
  const definition = tool?.function ?? tool;
  const signature = JSON.stringify([call, request.live.round, index]);
  if (!force && selection?.source === 'proxy' && selection.signature === signature) return;
  selection = {
    key: 'proxy:' + call.id,
    source: 'proxy',
    name: call.name || 'Receiving tool name…',
    description: definition?.description ?? '',
    schema: definition?.input_schema ?? definition?.parameters ?? { type: 'object' },
    signature,
  };
  let args;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    args = partialObject(call.arguments);
  }
  renderEditor(args);
  $('arguments-json').value = call.arguments || '{}';
}
/** Partial values are a visual preview only; never execute or return them as valid arguments. */
function partialObject(value) {
  const stack = [];
  let quote = false;
  let escape = false;
  for (const character of value) {
    if (escape) {
      escape = false;
      continue;
    }
    if (quote && character === '\\') {
      escape = true;
      continue;
    }
    if (character === '"') {
      quote = !quote;
      continue;
    }
    if (!quote) {
      if (character === '{') stack.push('}');
      if (character === '[') stack.push(']');
      if (character === '}' || character === ']') stack.pop();
    }
  }
  let text = value;
  if (escape) text = text.slice(0, -1);
  if (quote) text += '"';
  text = text.replace(/,\s*$/, '');
  if (/:\s*$/.test(text)) text += 'null';
  try {
    return JSON.parse(text + stack.reverse().join(''));
  } catch {
    return {};
  }
}
function renderFeed() {
  const entries = state.entries.filter(
    (e) => e.chatId === chatId && (filter === 'all' || e.kind === filter),
  );
  const signature = JSON.stringify([
    chatId,
    filter,
    entries.map((e) => e.id),
    state.requests.filter((r) => r.chatId === chatId).map((r) => [r.id, r.state]),
  ]);
  if (signature === feedSignature) return;
  const oldLast = $('feed').lastElementChild?.dataset.entry;
  const opened = new Set(
    [...$('feed').querySelectorAll('article > details[open]')].map(
      (d) => d.parentElement.dataset.entry,
    ),
  );
  const scroll = $('feed').scrollTop;
  feedSignature = signature;
  $('inbox-count').textContent = `${entries.length} entries`;
  $('feed').replaceChildren();
  if (!entries.length)
    $('feed').append(
      element('p', 'empty-note', 'Incoming model requests and MCP results appear here.'),
    );
  const newLast = entries.at(-1)?.id;
  for (const entry of entries) {
    const article = element('article', 'entry');
    article.dataset.entry = entry.id;
    const details = element('details');
    const summary = element('summary');
    const request = state.requests.find((r) => r.id === entry.requestId);
    summary.append(
      element('time', '', new Date(entry.at).toLocaleTimeString('en-GB')),
      element(
        'span',
        'entry-direction ' + entry.kind,
        {
          request: 'Client → App',
          response: 'App → Client',
          'tool-call': 'Tool call',
          'tool-result': 'MCP → App',
          error: 'Error',
        }[entry.kind] ??
          (entry.title.startsWith('Upstream request')
            ? 'App → Model'
            : entry.title.startsWith('Upstream response')
              ? 'Model → App'
              : 'Connection'),
      ),
      element('span', 'entry-title', entry.title),
      element(
        'span',
        'entry-state' + (pending(request) ? ' pending' : ''),
        entry.kind === 'request' ? (request?.state ?? '') : entry.kind === 'error' ? 'error' : '',
      ),
    );
    details.append(summary);
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const body = element('div', 'entry-body');
      if (entry.kind === 'request' && request?.parentRequestId) {
        const context = element(
          'div',
          'message-block',
          'Branch from ' + request.body.previous_response_id,
        );
        body.append(context);
        api('/api/requests/' + request.id + '/context')
          .then((effective) => {
            context.append(renderRequest({ ...request, body: effective }, request.body));
          })
          .catch((e) => context.append(element('p', 'error', e.message)));
      } else
        body.append(
          entry.kind === 'request' && request
            ? renderRequest(request)
            : ['tool-result', 'error'].includes(entry.kind)
              ? renderToolResult(entry.payload)
              : entry.kind === 'response' ||
                  (entry.kind === 'connection' && entry.title.startsWith('Upstream response'))
                ? renderResponse(entry.payload)
                : jsonView(entry.payload),
        );
      const actions = element('div', 'entry-actions');
      const copy = element('button', '', 'Copy JSON');
      copy.onclick = () =>
        navigator.clipboard
          .writeText(
            JSON.stringify(entry.kind === 'tool-result' ? entry.payload : entry.payload, null, 2),
          )
          .then(() => status('JSON copied'))
          .catch(() => error('Clipboard is unavailable'));
      actions.append(copy);
      if (entry.kind === 'request' && request) {
        const select = element(
          'button',
          '',
          pending(request) ? 'Select request' : 'Inspect request',
        );
        select.onclick = () => {
          requestId = request.id;
          selection = undefined;
          selectedCallIndex = null;
          toolsSignature = '';
          renderEditor();
          render();
        };
        actions.prepend(select);
      }
      body.append(actions);
      details.append(body);
    };
    details.addEventListener('toggle', () => {
      if (details.open) build();
    });
    const open = newLast !== oldLast ? entry.id === newLast : opened.has(entry.id);
    if (open) {
      details.open = true;
      build();
    }
    article.append(details);
    $('feed').append(article);
  }
  if ($('auto-scroll').checked && newLast !== oldLast)
    requestAnimationFrame(() => {
      $('feed').scrollTop = $('feed').scrollHeight;
    });
  else $('feed').scrollTop = scroll;
}
for (const button of document.querySelectorAll('[data-filter]'))
  button.onclick = () => {
    filter = button.dataset.filter;
    for (const other of document.querySelectorAll('[data-filter]'))
      other.setAttribute('aria-pressed', String(other === button));
    feedSignature = '';
    renderFeed();
  };
$('export-chat').onclick = () => {
  const data = {
    chat: state.chats.find((c) => c.id === chatId),
    requests: state.requests.filter((r) => r.chatId === chatId),
    entries: state.entries.filter((e) => e.chatId === chatId),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = element('a');
  a.href = url;
  a.download = `be-your-agent-${chatId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
let renaming = false;
function nameDialog(rename) {
  renaming = rename;
  $('name-title').textContent = rename ? 'Rename chat' : 'New chat';
  $('chat-name').value = rename ? (state.chats.find((c) => c.id === chatId)?.name ?? '') : '';
  $('name-dialog').showModal();
  $('chat-name').focus();
}
$('new-chat').onclick = () => nameDialog(false);
$('rename-chat').onclick = () => nameDialog(true);
$('name-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    const chat = await api(renaming ? '/api/chats/' + chatId : '/api/chats', {
      name: $('chat-name').value,
    });
    await refreshState();
    switchChat(chat.id);
    $('name-dialog').close();
  } catch (e) {
    error(e.message);
  }
};
$('active-upstream').onchange = async () => {
  try {
    await api('/api/chats/' + chatId + '/upstream', { id: $('active-upstream').value });
    await refreshState();
  } catch (e) {
    error(e.message);
    await refreshState();
  }
};
$('chat-mode').onchange = async () => {
  try {
    await api(`/api/chats/${chatId}/mode`, { mode: $('chat-mode').value });
    await refreshState();
    status('Mode applies to the next API request');
  } catch (e) {
    error(e.message);
  }
};
$('api-help').onclick = () => showEndpoints(chatId, state.apiTokenRequired);
const settings = setupSettings({
  api,
  getState: () => state,
  refresh: () => refreshState(),
  status,
});
function render() {
  if (!state.chats.some((c) => c.id === chatId)) chatId = state.chats[0]?.id ?? 'default';
  renderChats();
  renderRequests();
  renderTools();
  renderFeed();
  renderLive();
  $('mcp-count').textContent =
    `${state.mcp.filter((s) => s.state === 'connected').length}/${state.mcp.length}`;
}
let refreshing;
let again = false;
async function refreshState() {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      state = await api('/api/state');
      render();
    } while (again);
  })();
  try {
    await refreshing;
  } finally {
    refreshing = undefined;
  }
}
function setupResize() {
  const root = document.documentElement;
  const saved = JSON.parse(localStorage.getItem('column-widths') ?? 'null');
  if (saved)
    for (const [name, width] of Object.entries(saved))
      root.style.setProperty('--' + name, width + 'px');
  for (const handle of document.querySelectorAll('.resize-handle')) {
    const name = handle.dataset.boundary;
    const resize = (delta) => {
      const computed = getComputedStyle(root);
      const current = parseFloat(computed.getPropertyValue('--' + name));
      const min = { chats: 130, tools: 170, editor: 310 }[name];
      const other = ['chats', 'tools', 'editor']
        .filter((key) => key !== name)
        .reduce((sum, key) => sum + parseFloat(computed.getPropertyValue('--' + key)), 0);
      const max = Math.max(min, Math.max(innerWidth, 1050) - other - 310);
      root.style.setProperty(
        '--' + name,
        Math.round(Math.max(min, Math.min(max, current + delta))) + 'px',
      );
      localStorage.setItem(
        'column-widths',
        JSON.stringify(
          Object.fromEntries(
            ['chats', 'tools', 'editor'].map((key) => [
              key,
              parseFloat(getComputedStyle(root).getPropertyValue('--' + key)),
            ]),
          ),
        ),
      );
    };
    handle.onpointerdown = (event) => {
      handle.setPointerCapture(event.pointerId);
      let previous = event.clientX;
      handle.onpointermove = (move) => {
        resize(move.clientX - previous);
        previous = move.clientX;
      };
      handle.onpointerup = () => {
        handle.onpointermove = null;
      };
    };
    handle.onkeydown = (event) => {
      if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        resize(event.key === 'ArrowLeft' ? -15 : 15);
      }
    };
  }
}
setupResize();
await refreshState();
const events = new EventSource('/api/events');
let updateTimer;
events.onopen = () => {
  $('connection').textContent = 'Connected';
  $('connection').classList.add('online');
};
events.onerror = () => {
  $('connection').textContent = 'Reconnecting…';
  $('connection').classList.remove('online');
};
events.addEventListener('change', () => {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    void refreshState().catch((e) => status(e.message));
  }, 80);
});
events.addEventListener('live', (event) => {
  const value = JSON.parse(event.data);
  const request = state.requests.find((r) => r.id === value.id);
  if (!request) return;
  request.live = value.live;
  if (request.id === requestId) {
    renderRequests();
    renderLive();
  }
});
