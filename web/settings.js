import { element, jsonView } from './content.js';
const $ = (id) => document.getElementById(id);
const pretty = (value) => JSON.stringify(value, null, 2);
const blankServer = {
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  cwd: '',
  env: {},
  url: '',
  headers: {},
  auth: 'none',
  token: '',
  username: '',
  password: '',
  timeoutMs: 180000,
};
const endpoints = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  'chat-completions': 'https://api.openai.com/v1/chat/completions',
  responses: 'https://api.openai.com/v1/responses',
};

export function setupSettings({ api, getState, refresh, status }) {
  let selected = '';
  for (const button of document.querySelectorAll('[data-close]'))
    button.onclick = () => $(button.dataset.close).close();
  function visibility() {
    $('stdio-settings').hidden = $('server-transport').value !== 'stdio';
    $('http-settings').hidden = $('server-transport').value === 'stdio';
    $('bearer-settings').hidden = $('server-auth').value !== 'bearer';
    $('basic-settings').hidden = $('server-auth').value !== 'basic';
  }
  function serverList() {
    const list = $('server-list');
    list.replaceChildren();
    for (const server of getState().mcp) {
      const button = element('button', 'server-row' + (server.id === selected ? ' active' : ''));
      button.append(
        document.createTextNode(server.name),
        element(
          'small',
          '',
          server.state + (server.tools.length ? ` · ${server.tools.length} tools` : ''),
        ),
      );
      button.onclick = () => edit(server);
      list.append(button);
    }
  }
  function edit(server = blankServer) {
    selected = server.id ?? '';
    for (const key of [
      'id',
      'name',
      'transport',
      'command',
      'cwd',
      'url',
      'auth',
      'token',
      'username',
      'password',
    ])
      $('server-' + key).value = server[key] ?? '';
    for (const key of ['args', 'env', 'headers']) $('server-' + key).value = pretty(server[key]);
    $('server-timeout').value = String(server.timeoutMs / 1000);
    $('connect-server').disabled = !server.id || server.state === 'connecting';
    $('connect-server').textContent = server.state === 'connected' ? 'Disconnect' : 'Connect';
    $('remove-server').disabled = !server.id;
    $('mcp-error').textContent = server.error ?? '';
    visibility();
    serverList();
  }
  $('mcp-settings').onclick = () => {
    edit(getState().mcp.find((s) => s.id === selected) ?? getState().mcp[0] ?? blankServer);
    $('mcp-dialog').showModal();
  };
  $('new-server').onclick = () => edit();
  $('server-transport').onchange = visibility;
  $('server-auth').onchange = visibility;
  $('session-runner-preset').onclick = () =>
    edit({
      ...blankServer,
      name: 'Session runner',
      command: 'node',
      args: ['D:\\Projects\\AI Hub\\session_runner_mcp\\dist\\src\\main.js'],
      env: {
        MCP_ENV_FILE: 'D:/Projects/AI Hub/session_runner_mcp/.env',
        MCP_TRANSPORT: 'stdio',
        MCP_DATA_DIR: 'D:/Projects/AI Hub/session_runner_mcp/runs',
      },
    });
  $('mcp-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $('mcp-error').textContent = '';
    try {
      const config = {};
      for (const key of [
        'name',
        'transport',
        'command',
        'cwd',
        'url',
        'auth',
        'token',
        'username',
        'password',
      ])
        config[key] = $('server-' + key).value;
      if (selected) config.id = selected;
      for (const key of ['args', 'env', 'headers'])
        config[key] = JSON.parse($('server-' + key).value);
      config.timeoutMs = Number($('server-timeout').value) * 1000;
      const saved = await api('/api/mcp/save', config);
      await refresh();
      edit(getState().mcp.find((s) => s.id === saved.id));
      status('MCP configuration saved');
    } catch (error) {
      $('mcp-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  $('connect-server').onclick = async () => {
    const button = $('connect-server');
    const server = getState().mcp.find((s) => s.id === selected);
    if (!server) return;
    button.disabled = true;
    $('mcp-error').textContent = '';
    try {
      await api(
        `/api/mcp/${selected}/${server.state === 'connected' ? 'disconnect' : 'connect'}`,
        {},
      );
      await refresh();
      edit(getState().mcp.find((s) => s.id === selected));
      status('MCP connection updated');
    } catch (error) {
      $('mcp-error').textContent = error.message;
      await refresh();
      serverList();
    } finally {
      button.disabled = false;
    }
  };
  $('remove-server').onclick = async () => {
    try {
      await api(`/api/mcp/${selected}/remove`, {});
      await refresh();
      edit();
    } catch (error) {
      $('mcp-error').textContent = error.message;
    }
  };
  let editingModel;
  function modelList() {
    const list = $('upstream-list');
    list.replaceChildren();
    for (const config of getState().upstreams) {
      const row = element('div', 'model-row');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = config.enabled;
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', 'Enable ' + config.name);
      toggle.onchange = async () => {
        toggle.disabled = true;
        try {
          await api('/api/upstreams/' + config.id + '/enabled', { enabled: toggle.checked });
          await refresh();
        } catch (e) {
          toggle.checked = !toggle.checked;
          $('upstream-error').textContent = e.message;
        } finally {
          toggle.disabled = false;
        }
      };
      const button = element('button', editingModel === config.id ? 'active' : '', config.name);
      button.onclick = () => editUpstream(config);
      row.append(toggle, button);
      list.append(row);
    }
  }
  function editUpstream(config) {
    editingModel = config?.id;
    $('remove-upstream').disabled = !editingModel;
    const protocol = config?.protocol ?? 'anthropic';
    $('upstream-protocol').value = protocol;
    $('upstream-name').value = config?.name ?? '';
    modelList();
    $('upstream-url').value = config?.url ?? endpoints[protocol];
    $('upstream-key').value = config?.key ?? '';
    $('upstream-model').value = config?.model ?? '';
    $('upstream-headers').value = pretty(config?.headers ?? {});
    $('upstream-mcp').checked = config?.includeMcp ?? true;
    $('upstream-rounds').value = config?.maxRounds ?? 12;
    $('upstream-error').textContent = '';
  }
  $('upstream-settings').onclick = () => {
    editUpstream(getState().upstreams.find((c) => c.id === $('active-upstream').value));
    $('upstream-dialog').showModal();
  };
  $('remove-upstream').onclick = async () => {
    if (!editingModel || !confirm('Remove this model connection?')) return;
    try {
      await api('/api/upstreams/' + editingModel + '/remove', {});
      await refresh();
      editUpstream();
    } catch (e) {
      $('upstream-error').textContent = e.message;
    }
  };
  $('new-upstream').onclick = () => editUpstream();
  $('upstream-protocol').onchange = () => {
    if (Object.values(endpoints).includes($('upstream-url').value))
      $('upstream-url').value = endpoints[$('upstream-protocol').value];
  };
  $('upstream-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      await api('/api/upstreams', {
        id: editingModel ?? crypto.randomUUID(),
        name: $('upstream-name').value,
        enabled: getState().upstreams.find((c) => c.id === editingModel)?.enabled ?? true,
        protocol: $('upstream-protocol').value,
        url: $('upstream-url').value,
        key: $('upstream-key').value,
        model: $('upstream-model').value,
        headers: JSON.parse($('upstream-headers').value),
        includeMcp: $('upstream-mcp').checked,
        maxRounds: Number($('upstream-rounds').value),
      });
      await refresh();
      $('upstream-dialog').close();
      status('Upstream configuration saved');
    } catch (error) {
      $('upstream-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  return { serverList };
}

export function showInfo(title, content) {
  $('info-title').textContent = title;
  $('info-content').replaceChildren(content);
  if (!$('info-dialog').open) $('info-dialog').showModal();
}
export function showEndpoints(chatId, tokenRequired) {
  const node = element('div');
  const base = location.origin + '/chats/' + chatId;
  node.append(
    element('p', 'muted', 'Use this chat’s base URL, or send X-Chat-Id with a shared base URL.'),
  );
  node.append(element('h3', '', 'Anthropic · base_url'), jsonView(base));
  node.append(element('h3', '', 'OpenAI · base_url'), jsonView(base + '/v1'));
  node.append(
    element('h3', '', 'POST endpoints'),
    jsonView({
      anthropic: base + '/v1/messages',
      chatCompletions: base + '/v1/chat/completions',
      responses: base + '/v1/responses',
    }),
  );
  node.append(
    element(
      'p',
      'muted',
      tokenRequired
        ? 'Use the configured API_TOKEN as Bearer or x-api-key.'
        : 'API key is optional. SDKs that require one can use “local”.',
    ),
  );
  node.append(
    element(
      'p',
      'hint',
      'Requests wait for your response in Human mode. Increase client timeouts and disable automatic retries. Streaming connections send keepalive comments. Responses can continue from a stored previous_response_id. Other clients send the conversation in messages.',
    ),
  );
  showInfo('API endpoints', node);
}
