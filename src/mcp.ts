import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { JsonFile } from './storage.js';
import { InputError, validateArguments } from './validation.js';

const configSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(100),
    transport: z.enum(['stdio', 'http', 'sse']),
    url: z.string().default(''),
    command: z.string().default(''),
    args: z.array(z.string()).default([]),
    cwd: z.string().default(''),
    env: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    auth: z.enum(['none', 'bearer', 'basic']).default('none'),
    token: z.string().default(''),
    username: z.string().default(''),
    password: z.string().default(''),
    timeoutMs: z.number().int().min(1000).max(600000).default(180000),
  })
  .strict();
export type McpConfig = z.infer<typeof configSchema> & { id: string };
interface Connection {
  client: Client;
  tools: Tool[];
  state: 'connecting' | 'connected' | 'error';
  error?: string;
}
const masked = '••••••••';

/** Owns long-lived MCP clients, so windowId and server sessions survive individual UI calls. */
export class McpConnections extends EventEmitter {
  private configs: McpConfig[] = [];
  private connections = new Map<string, Connection>();
  private file: JsonFile<McpConfig[]>;
  constructor(directory: string) {
    super();
    this.file = new JsonFile(join(directory, 'mcp.json'));
  }
  async load() {
    this.configs = await this.file.read([]);
  }
  snapshot() {
    return this.configs.map((c) => {
      const connection = this.connections.get(c.id);
      return {
        ...c,
        token: c.token ? masked : '',
        password: c.password ? masked : '',
        env: Object.fromEntries(Object.keys(c.env).map((key) => [key, masked])),
        headers: Object.fromEntries(Object.keys(c.headers).map((key) => [key, masked])),
        state: connection?.state ?? 'disconnected',
        error: connection?.error,
        tools: connection?.tools ?? [],
        instructions: connection?.client.getInstructions(),
        server: connection?.client.getServerVersion(),
      };
    });
  }
  async save(input: unknown) {
    const config = configSchema.parse(input);
    const previous = this.configs.find((c) => c.id === config.id);
    for (const key of ['token', 'password'] as const)
      if (config[key] === masked) config[key] = previous?.[key] ?? '';
    for (const key of ['env', 'headers'] as const)
      for (const [name, value] of Object.entries(config[key]))
        if (value === masked) {
          if (!previous?.[key][name]) throw new InputError(`No saved value for ${name}`);
          config[key][name] = previous[key][name];
        }
    if (config.transport === 'stdio') {
      if (!config.command.trim()) throw new InputError('Command is required');
    } else {
      let url: URL;
      try {
        url = new URL(config.url);
      } catch {
        throw new InputError('Enter a valid MCP URL');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new InputError('Use an HTTP(S) URL and configure authentication separately');
    }
    if (config.auth === 'bearer' && !config.token) throw new InputError('Bearer token is required');
    await this.disconnect(config.id ?? '');
    const saved = { ...config, id: config.id ?? randomUUID() };
    this.configs = [...this.configs.filter((c) => c.id !== saved.id), saved];
    await this.file.write(this.configs);
    this.emit('change');
    return this.snapshot().find((c) => c.id === saved.id)!;
  }
  async remove(id: string) {
    this.config(id);
    await this.disconnect(id);
    this.configs = this.configs.filter((c) => c.id !== id);
    await this.file.write(this.configs);
    this.emit('change');
  }
  private config(id: string) {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new InputError('MCP server not found', 404);
    return config;
  }
  async connect(id: string) {
    const config = this.config(id);
    const existing = this.connections.get(id);
    if (existing?.state === 'connecting')
      throw new InputError('Connection is already in progress', 409);
    await this.disconnect(id);
    const client = new Client({ name: 'be-your-agent', version: '0.1.0' });
    const connection: Connection = { client, tools: [], state: 'connecting' };
    this.connections.set(id, connection);
    this.emit('change');
    const headers = { ...config.headers };
    if (config.auth === 'bearer') headers.Authorization = 'Bearer ' + config.token;
    if (config.auth === 'basic')
      headers.Authorization =
        'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...config.env }).filter(
        (pair): pair is [string, string] => pair[1] !== undefined,
      ),
    );
    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd || undefined,
            env,
            stderr: 'pipe',
          })
        : config.transport === 'http'
          ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
          : new SSEClientTransport(new URL(config.url), {
              requestInit: { headers },
              eventSourceInit: {
                fetch: (url, init) =>
                  fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } }),
              },
            });
    // Drain child stderr; credentials or provider debug bodies never enter browser history.
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
    const fail = () => {
      if (this.connections.get(id) !== connection) return;
      connection.state = 'error';
      connection.error = 'Connection closed. Reconnect the MCP server.';
      this.emit('change');
    };
    client.onclose = fail;
    client.onerror = fail;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.refresh(id);
      } catch {
        fail();
      }
    });
    try {
      await client.connect(transport, { timeout: Math.min(config.timeoutMs, 60000) });
      if (this.connections.get(id) !== connection) {
        await client.close();
        return;
      }
      connection.state = 'connected';
      await this.refresh(id);
    } catch (error) {
      await client.close().catch(() => {});
      connection.state = 'error';
      connection.error = 'Could not connect. Check the command, URL and authentication settings.';
      this.emit('change');
      throw new InputError(connection.error, 502);
    }
  }
  async refresh(id: string) {
    const connection = this.connections.get(id);
    if (!connection || connection.state !== 'connected')
      throw new InputError('Connect this MCP server first', 409);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await connection.client.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new InputError('MCP repeated its pagination cursor', 502);
      if (cursor) seen.add(cursor);
      if (tools.length > 10000) throw new InputError('MCP tool catalogue is too large', 502);
    } while (cursor);
    connection.tools = tools;
    this.emit('change');
  }
  async call(id: string, name: string, args: unknown) {
    const config = this.config(id);
    const connection = this.connections.get(id);
    if (!connection || connection.state !== 'connected')
      throw new InputError('Connect this MCP server first', 409);
    const tool = connection.tools.find((t) => t.name === name);
    if (!tool) throw new InputError('Unknown MCP tool', 404);
    validateArguments(tool.inputSchema, args);
    return connection.client.callTool(
      { name, arguments: args as Record<string, unknown> },
      undefined,
      { timeout: config.timeoutMs },
    );
  }
  proxyTools() {
    return this.configs.flatMap((config) => {
      const connection = this.connections.get(config.id);
      if (connection?.state !== 'connected') return [];
      return connection.tools.map((tool) => ({
        name:
          'mcp_' +
          createHash('sha256')
            .update(config.id + ':' + tool.name)
            .digest('hex')
            .slice(0, 12) +
          '_' +
          tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 45),
        description: `[MCP: ${config.name} / ${tool.name}] ${tool.description ?? ''}`,
        schema: tool.inputSchema,
        serverId: config.id,
        serverName: config.name,
        toolName: tool.name,
      }));
    });
  }
  async disconnect(id: string) {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (connection) await connection.client.close();
    this.emit('change');
  }
  async close() {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
