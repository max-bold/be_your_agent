# be_your_agent

A local, human-operated model endpoint and MCP workbench. Point an agent at this application instead of a model provider to see its full request, select tools, and manually return an assistant response. Switch a chat to **Proxy** to watch a real model work with the same environment.

The implementation is independent of `session_runner`. It reuses the compact neutral dark visual style and the tools → request → inbox workflow, with a chat sidebar and a permanent text composer under the two central columns. The layout uses the full browser width; drag the separators to resize columns.

![The be_your_agent workbench with Chats, Tools, Request, and Inbox panels](./Screenshot%202026-11-19%20165455.png)

## Run

Requires Node.js 22 or newer.

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm start
```

Open **http://127.0.0.1:4320**. For development use `npm run dev`.

Configuration in `.env`:

| Setting     | Default | Meaning                                                                     |
| ----------- | ------- | --------------------------------------------------------------------------- |
| `PORT`      | `4320`  | Local HTTP port                                                             |
| `API_TOKEN` | empty   | Optional API key required for model requests, sent as Bearer or `x-api-key` |
| `DATA_DIR`  | `.data` | Local history and connection settings                                       |

The server listens on loopback. UI mutations require a same-origin workbench request. No hosted service is needed.

## Human mode

1. Point the client at one of the endpoints below. An incoming request remains open until you answer or cancel it.
2. Select a request in **Responding to**. Its full messages, system instructions, parameters and tool schemas are available in Inbox. Images can be previewed; binary MCP resources can be downloaded.
3. Write in the permanent **Text response** field. Select a request tool, fill its arguments and choose **Add to response**. Repeat to assemble several calls. Existing calls can be edited or removed.
4. Choose **Preview JSON** to inspect the protocol-native response, then **Send response** or **Ctrl+Enter** to send it. If a request tool is currently being edited, Ctrl+Enter includes that call in the response.
5. The external client executes its tools and sends a new request with the results. The workbench does not execute client-defined tools itself.

Anthropic responses can contain text and multiple `tool_use` blocks in one `content` array. Tool-bearing responses use `stop_reason: tool_use`. Forced `tool_choice: any/tool` puts calls before text; `disable_parallel_tool_use` restricts the answer to one call. OpenAI Chat Completions returns `message.tool_calls`; Responses returns `function_call` output items.

Schema validation runs on the server before sending an answer. It honors required properties, enums, nested objects and arrays. Fields and JSON views share the same values. Complex schemas can be edited in JSON; the original schema is always available. Defaults remain optional unless the schema requires the property.

**Ctrl+Enter inside a direct MCP tool editor runs that MCP tool.** Ctrl+Enter in the text composer or a client-defined tool editor sends the model response. Settings dialogs use their own Save buttons.

## API endpoints

| API style               | Endpoint                    | SDK base URL               |
| ----------------------- | --------------------------- | -------------------------- |
| Anthropic Messages      | `POST /v1/messages`         | `http://127.0.0.1:4320`    |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `http://127.0.0.1:4320/v1` |
| OpenAI Responses        | `POST /v1/responses`        | `http://127.0.0.1:4320/v1` |
| Model discovery         | `GET /v1/models`            | returns `human`            |

Both JSON and SSE responses are supported. The model name is accepted as supplied. Human-mode token usage is zero because no model is called. SSE sends keepalive comments while waiting; content is emitted when you submit the complete response.

Configure long client timeouts and disable automatic retries: a human can take several minutes to answer. Retried requests appear as separate requests.

An SDK example:

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:4320",
    api_key="local",  # use API_TOKEN if configured
    timeout=3600,
    max_retries=0,
)
response = client.messages.create(
    model="human",
    max_tokens=2048,
    messages=[{"role": "user", "content": "Inspect the environment."}],
    tools=[{
        "name": "inspect",
        "description": "Inspect an object",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    }],
)
print(response)
```

### Chats

Responses can continue from any locally stored response via `previous_response_id`, including earlier branch points. Only the parent chain's inputs and client-visible outputs are replayed. Top-level instructions apply to the current request. Explicit `store: false` excludes that reply from continuation, while the debug timeline still records the exchange. Unknown or unavailable parents return an error before upstream execution. Responses `conversation`, background responses, multiple completion choices and provider-hosted tools are explicitly unsupported in this version.

Choose **API endpoints** in the UI to copy the current chat's scoped URLs:

```text
Anthropic base_url: http://127.0.0.1:4320/chats/CHAT_ID
OpenAI base_url:    http://127.0.0.1:4320/chats/CHAT_ID/v1
```

Alternatively, use the common endpoints and send `X-Chat-Id: CHAT_ID` or `metadata.chat_id`. Known client-visible tool-result IDs can also identify a chat. Conflicting references return HTTP 400. An ambiguous tool-result ID creates a new chat unless another reference disambiguates it. Each request without a known reference starts its own chat, named from its first user message. Workbench remains available for direct MCP calls. Concurrent requests have independent response destinations. Switching chats cannot redirect an in-flight tool result or model answer.

Inbox shows entries as expandable rows. The latest new entry expands automatically; **Follow** scrolls to it. **Copy JSON** on a tool result includes server, tool name, arguments and the result. **Export** downloads the selected chat's complete record.

## Direct MCP access

Open **MCP servers** to add any number of connections:

- **stdio**: executable, JSON argument array, working directory and environment variables.
- **Streamable HTTP**: full MCP endpoint URL.
- **Legacy SSE**: SSE endpoint URL.
- HTTP authentication: Bearer, HTTP Basic or custom headers. Interactive OAuth login/token refresh is not implemented; use a supplied access token where supported.

Save, then explicitly connect. Tool discovery follows pagination and refreshes on server notifications. Each configured server keeps one long-lived MCP connection shared by the workbench's chats. MCP-specific session identifiers such as `windowId` remain normal tool arguments.

Connected tools appear under their server name in the left column. **Run MCP tool** executes immediately and writes the request and full result to Inbox; it does not add a tool call to a pending model response.

The **Session runner preset** fills the command and environment for `D:\Projects\AI Hub\session_runner_mcp`. It does not import credentials or start the server until you save and connect.

Credentials are saved locally in `.data/mcp.json` and `.data/upstreams.json`, masked in browser state, and excluded from Git. Editing a configuration disconnects that server. Removing masked JSON keys removes the saved values; unchanged masked values are preserved. Local history contains the model inputs and tool results you intentionally inspect.

## Proxy mode

1. Open **Edit models** and add a named connection with its API style, full endpoint URL, credentials and model ID. Enable the models you want in the toolbar and select one per chat. Proxy mode translates text conversations and function calls between Anthropic Messages, Chat Completions and Responses. Same-format traffic retains its native body. Cross-format requests with unsupported blocks or options return an error. When translating to Anthropic without an explicit output limit, the proxy uses 4096 tokens.
2. Choose whether to expose connected MCP tools and set the maximum number of model rounds per client request (default 12).
3. Switch the selected chat from **Human** to **Proxy**. This applies to subsequent requests; it does not change requests already in progress.

Client tool definitions pass through. Connected MCP tools receive stable, namespaced aliases and their server instructions are supplied to the upstream. Calls to these aliases execute in the workbench; their results are supplied in a further model round. Client-defined calls return to the original client for execution. If both kinds are available, tool calls are serialized to prevent a response batch from mixing execution owners. An upstream that ignores that restriction receives an explicit error rather than accidentally executing a client-owned tool.

Every upstream request, response and MCP call is recorded in Inbox. The central editor shows streaming tool arguments as they arrive, with partial JSON shown as a read-only preview; the text composer displays upstream text. Usage returned to the client aggregates all internal model rounds. Proxy calls consume the configured provider's tokens.

The client receives the final response after internal MCP rounds finish. Its SSE connection stays alive, while upstream deltas are displayed live in the workbench. This buffering is necessary to avoid leaking internal MCP calls to a client that cannot execute them. For Anthropic, MCP images retain their image content type; Chat Completions and Responses currently serialize full MCP results as JSON text, including binary blocks.

## Code map

| Path                         | Responsibility                                                 |
| ---------------------------- | -------------------------------------------------------------- |
| `src/main.ts`                | Configuration and local startup                                |
| `src/server.ts`              | HTTP routes, connection lifecycle and UI event stream          |
| `src/workbench.ts`           | Chat history, pending model requests and response destinations |
| `src/protocols/requests.ts`  | Normalize tool definitions and validate manual answers         |
| `src/protocols/responses.ts` | Protocol-native JSON and SSE response writers                  |
| `src/proxy.ts`               | Upstream settings, stream inspection and model/MCP loop        |
| `src/mcp.ts`                 | MCP clients, discovery, authentication and calls               |
| `src/storage.ts`             | Ordered atomic JSON persistence                                |
| `web/app.js`                 | Workspace state, drafts, tool editor and Inbox                 |
| `web/schema.js`              | Generic JSON Schema form controls                              |
| `web/content.js`             | Message, media and raw JSON rendering                          |
| `web/settings.js`            | MCP and upstream settings dialogs                              |

## Verification

```powershell
npm run check
npm test
npm run build
npm run test:ui
```

Protocol tests use the official Anthropic and OpenAI SDKs for JSON and SSE, including text plus two tool calls. Integration tests cover chat isolation, cancellation, MCP stdio and a full upstream → MCP → upstream loop for all three API styles. The browser smoke test exercises draft assembly, Ctrl+Enter, the MCP settings dialog, a direct MCP call, upstream settings and chat navigation using local fixtures. It saves a screenshot to `.data/ui-smoke.png`.

The browser smoke test requires Playwright Chromium (`npx playwright install chromium` if it is not installed).

Protocol references: [Anthropic tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Responses SSE events](https://developers.openai.com/api/reference/resources/responses/streaming-events), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/1.32.2).
