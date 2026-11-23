import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer, hideTool, registerTools } from './server.js';

let count = 0;

function fixture(): string {
  const name = `hide_fixture_${++count}`;
  registerTools([
    {
      tool: { name, inputSchema: { type: 'object', properties: {} } },
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }),
    },
  ]);
  return name;
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: 'fixture', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const listed = async (client: Client, name: string) => (await client.listTools()).tools.some((t) => t.name === name);

describe('hideTool', () => {
  it('leaves a tool alone when nothing hides it', async () => {
    const name = fixture();
    await withClient(async (client) => {
      expect(await listed(client, name)).toBe(true);
      expect((await client.callTool({ name })).content).toEqual([{ type: 'text', text: 'ran' }]);
    });
  });

  it('leaves a hidden tool out of the list and answers a call like a missing tool', async () => {
    const name = fixture();
    let hidden = true;
    hideTool(name, () => hidden);
    await withClient(async (client) => {
      expect(await listed(client, name)).toBe(false);
      expect((await client.callTool({ name })).content).toEqual([{ type: 'text', text: `Unknown tool: ${name}` }]);
      expect((await client.callTool({ name: 'no_such_tool' })).content).toEqual([
        { type: 'text', text: 'Unknown tool: no_such_tool' },
      ]);
      hidden = false;
      expect(await listed(client, name)).toBe(true);
      expect((await client.callTool({ name })).content).toEqual([{ type: 'text', text: 'ran' }]);
    });
  });

  it('hides when any of several conditions is true', async () => {
    const name = fixture();
    let second = false;
    hideTool(name, () => false);
    hideTool(name, () => second);
    await withClient(async (client) => {
      expect(await listed(client, name)).toBe(true);
      second = true;
      expect(await listed(client, name)).toBe(false);
    });
  });
});
