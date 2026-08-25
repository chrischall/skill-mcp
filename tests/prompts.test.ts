/**
 * The prompt and resource projection (docs/SKILL-MCP.md §2.2).
 *
 * A second door, never the only one: a client that supports prompts shows a
 * skill in its slash-command menu and a bundled file in its attachment picker,
 * which is a better presentation than a tool call — but mcp-host's
 * `enabledTools` narrowing empties both surfaces, so every skill stays
 * reachable through `skill_load` and every file through `skill_file`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDeps } from '../src/deps.js';
import { registerSkillPrompts } from '../src/prompts.js';

let root = '';
let client: Client;
let server: McpServer;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-prompts-')));
  const demo = join(root, 'demo');
  await mkdir(join(demo, 'references'), { recursive: true });
  await writeFile(
    join(demo, 'SKILL.md'),
    '---\nname: demo\ndescription: A fixture skill.\n---\n# Demo\n\nInstructions here.\n',
  );
  await writeFile(join(demo, 'references', 'notes.md'), 'Some notes.\n');

  const deps = await createDeps({ MCP_SKILLS_PATH: root });
  server = new McpServer({ name: 'test', version: '0.0.0' });
  registerSkillPrompts(server, deps);

  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('prompts', () => {
  it('registers one prompt per skill, named for the skill', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['demo']);
    expect(prompts[0]?.description).toContain('A fixture skill.');
  });

  it('serves the SKILL.md body as the prompt message', async () => {
    const result = await client.getPrompt({ name: 'demo' });
    const text = result.messages[0]?.content;
    expect(text?.type).toBe('text');
    expect(text && 'text' in text ? text.text : '').toContain('Instructions here.');
  });
});

describe('resources', () => {
  it('registers each bundled file under skill://<name>/<path>', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(['skill://demo/SKILL.md', 'skill://demo/references/notes.md']);
  });

  it('reads a bundled file through its resource URI', async () => {
    const result = await client.readResource({ uri: 'skill://demo/references/notes.md' });
    const contents = result.contents[0];
    expect(contents && 'text' in contents ? contents.text : '').toBe('Some notes.\n');
  });

  it('refuses a resource URI that leaves the skill directory', async () => {
    await expect(client.readResource({ uri: 'skill://demo/../outside.txt' })).rejects.toThrow();
  });
});
