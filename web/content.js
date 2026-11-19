export function element(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function jsonView(value) {
  return element('pre', 'payload', JSON.stringify(value, null, 2));
}
export function rawDetails(value, label = 'Raw JSON') {
  const node = element('details', 'raw-details');
  node.append(element('summary', '', label));
  node.addEventListener('toggle', () => {
    if (node.open && node.childElementCount === 1) node.append(jsonView(value));
  });
  return node;
}
function download(data, mime, name) {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) return element('p', 'muted', 'Invalid encoded file');
  const a = element('a', 'media-download', 'Download ' + name);
  a.href = 'data:application/octet-stream;base64,' + data;
  a.download = name;
  return a;
}
function block(value) {
  const node = element('div');
  if (typeof value === 'string') {
    node.append(element('p', '', value));
    return node;
  }
  if (!value || typeof value !== 'object') {
    node.append(jsonView(value));
    return node;
  }
  const text = value.text ?? (value.type === 'text' ? value.content : undefined);
  if (typeof text === 'string') node.append(element('p', '', text));
  const source = value.source;
  const mime = value.mimeType ?? source?.media_type ?? value.resource?.mimeType ?? '';
  const data =
    value.data ?? (source?.type === 'base64' ? source.data : undefined) ?? value.resource?.blob;
  const imageUrl =
    value.image_url?.url ?? (typeof value.image_url === 'string' ? value.image_url : undefined);
  if (typeof data === 'string') {
    if (/^image\/(png|jpeg|webp|gif)$/.test(mime)) {
      const image = element('img', 'content-image');
      image.alt = value.name ?? 'Image content';
      image.src = `data:${mime};base64,${data}`;
      node.append(image);
    }
    node.append(
      download(data, mime, value.name ?? (value.resource?.uri?.split('/').at(-1) || 'artifact')),
    );
  } else if (imageUrl || source?.url) {
    const url = imageUrl ?? source.url;
    if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(url)) {
      const img = element('img', 'content-image');
      img.alt = 'Image content';
      img.src = url;
      node.append(img);
    } else node.append(element('p', 'muted', 'Image URL: ' + url));
  }
  if (value.type === 'tool_result') {
    node.append(element('span', 'role', 'tool_result / ' + value.tool_use_id));
    node.append(renderContent(value.content));
  } else if (['tool_use', 'function_call', 'function_call_output'].includes(value.type))
    node.append(jsonView(value));
  else if (!node.childNodes.length) node.append(jsonView(value));
  return node;
}
export function renderContent(content) {
  const node = element('div', 'content-blocks');
  for (const item of Array.isArray(content) ? content : [content]) node.append(block(item));
  return node;
}
export function renderRequest(request, original = request.body) {
  const node = element('div');
  const body = request.body;
  for (const [name, content] of [
    ['system', body.system],
    ['instructions', body.instructions],
  ]) {
    if (!content) continue;
    const section = element('div', 'message-block');
    section.append(element('span', 'role', name), renderContent(content));
    node.append(section);
  }
  const messages =
    body.messages ??
    (typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : (body.input ?? []));
  for (const message of messages) {
    const section = element('div', 'message-block');
    section.append(element('span', 'role', message.role ?? message.type ?? 'input'));
    section.append(renderContent(message.content ?? message));
    if (message.tool_calls) section.append(jsonView(message.tool_calls));
    node.append(section);
  }
  node.append(rawDetails(original, 'Complete request · parameters and tool schemas'));
  return node;
}
export function renderResponse(response) {
  const node = element('div');
  const section = element('div', 'message-block');
  section.append(element('span', 'role', 'assistant'));
  function show(part) {
    if (part == null) return;
    if (Array.isArray(part)) return part.forEach(show);
    if (part.type === 'message') return show(part.content);
    if (part.type === 'reasoning' || part.type === 'thinking') {
      section.append(rawDetails(part, 'Reasoning'));
    } else if (['function', 'function_call', 'tool_use'].includes(part.type)) {
      const call = part.function ?? part;
      let args = call.arguments ?? call.input;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          /* Keep incomplete arguments inspectable. */
        }
      }
      section.append(rawDetails(args, 'Tool call · ' + call.name));
    } else {
      section.append(renderContent(part.refusal ?? part));
    }
  }
  if (response.choices) {
    for (const { message } of response.choices) {
      show(message?.content);
      show(message?.refusal);
      show(message?.tool_calls);
    }
  } else show(response.output ?? response.content);
  node.append(section, rawDetails(response, 'Complete response · JSON'));
  return node;
}
function toolResultView(value) {
  // Show literal quotes and backslashes in the preview. Raw JSON uses jsonView.
  const preview = JSON.stringify(value, null, 2).replace(/\\(["\\])/g, '$1');
  return element('pre', 'payload', preview);
}
function renderToolText(text) {
  try {
    return toolResultView(JSON.parse(text));
  } catch {
    // Some MCP servers prefix the response body with a JSON status line.
    const newline = text.indexOf('\n');
    if (newline > 0) {
      try {
        const status = JSON.parse(text.slice(0, newline));
        const body = JSON.parse(text.slice(newline + 1));
        const section = element('div');
        section.append(toolResultView(status), toolResultView(body));
        return section;
      } catch {
        // Keep mixed JSON and prose readable in its original form.
      }
    }
    return renderContent(text);
  }
}
export function renderToolResult(payload) {
  const node = element('div');
  node.append(
    rawDetails(
      {
        serverId: payload.serverId,
        name: payload.name,
        arguments: payload.arguments,
        durationMs: payload.durationMs,
      },
      'Tool request',
    ),
  );
  const result = payload.result;
  if (result?.structuredContent) node.append(toolResultView(result.structuredContent));
  for (const content of result?.content ?? []) {
    if (content.type === 'text' && result?.structuredContent) continue;
    if (content.type === 'text') node.append(renderToolText(content.text));
    else node.append(renderContent(content));
  }
  if (payload.error) node.append(element('pre', 'error', payload.error));
  node.append(rawDetails(result ?? payload));
  return node;
}
