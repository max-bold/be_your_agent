import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fixture', version: '1' },
  { capabilities: { tools: {} }, instructions: 'Use echo to inspect a value.' },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Return the supplied text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: JSON.stringify({ echo: request.params.arguments?.text }) }],
  structuredContent: { echo: request.params.arguments?.text },
}));
await server.connect(new StdioServerTransport());
