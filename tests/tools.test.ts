/**
 * The four tools, driven through the real client RPC path.
 *
 * Tools carry the whole experience (docs/SKILL-MCP.md §2.2): mcp-host's
 * `enabledTools` narrowing names TOOLS, and while it is set `prompts/list` and
 * `resources/list` come back empty and the handshake stops advertising those
 * capabilities — so nothing may be reachable only as a prompt or a resource.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import { registerSkillTools } from '../src/tools/skills.js';

let root = '';
let harness: Awaited<ReturnType<typeof createTestHarness>>;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-tools-')));

  const demo = join(root, 'demo');
  await mkdir(join(demo, 'scripts'), { recursive: true });
  await mkdir(join(demo, 'references'), { recursive: true });
  await writeFile(
    join(demo, 'SKILL.md'),
    [
      '---',
      'name: demo',
      'description: A fixture skill.',
      'when-to-use: When a fixture is needed.',
      'mcp-host:',
      '  version: 1',
      '  run:',
      '    - script: scripts/echo.js',
      '      interpreter: node',
      '    - script: scripts/py.py',
      '      interpreter: python3',
      '  egress: [api.example.com]',
      '---',
      '# Demo',
      '',
      'Read references/notes.md for detail.',
      '',
    ].join('\n'),
  );
  await writeFile(join(demo, 'scripts', 'echo.js'), `process.stdout.write('ran ' + process.argv.slice(2).join(','));\n`);
  await writeFile(join(demo, 'scripts', 'py.py'), 'print(1)\n');
  await writeFile(join(demo, 'references', 'notes.md'), 'Some notes.\n');
  await writeFile(join(demo, 'references', 'pixel.png'), PNG);

  const plain = join(root, 'plain');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'SKILL.md'), '---\nname: plain\ndescription: Instructions only.\n---\nJust text.\n');

  const deps = await createDeps({ MCP_SKILLS_PATH: root });
  harness = await createTestHarness((server) => registerSkillTools(server, deps));
});

afterAll(async () => {
  await harness?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('the tool roster', () => {
  it('registers exactly the four tools of the design', async () => {
    const names = (await harness.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['skill_file', 'skill_list', 'skill_load', 'skill_run']);
  });
});

describe('skill_list', () => {
  it('names every skill with its description, when-to-use and script list', async () => {
    const body = parseToolResult<{
      skills: {
        name: string;
        description?: string;
        whenToUse?: string;
        files: number;
        executable: boolean;
        scripts: { script: string; interpreter: string }[];
      }[];
    }>(await harness.callTool('skill_list'));

    const demo = body.skills.find((s) => s.name === 'demo');
    expect(demo?.description).toBe('A fixture skill.');
    expect(demo?.whenToUse).toBe('When a fixture is needed.');
    expect(demo?.files).toBe(5); // SKILL.md + 2 scripts + 2 references
    expect(demo?.executable).toBe(true);
    expect(demo?.scripts.map((s) => s.script)).toEqual(['scripts/echo.js']);
  });

  it('names the EXACT scripts rather than only "this skill has scripts"', async () => {
    const body = parseToolResult<{ skills: { name: string; scripts: unknown[] }[] }>(
      await harness.callTool('skill_list'),
    );
    expect(body.skills.find((s) => s.name === 'demo')?.scripts).toHaveLength(1);
  });

  it('reports a declared script this deployment cannot run, as a refusal rather than an omission', async () => {
    const body = parseToolResult<{
      skills: { name: string; unavailableScripts: { script: string; reason: string }[] }[];
    }>(await harness.callTool('skill_list'));
    const demo = body.skills.find((s) => s.name === 'demo');
    expect(demo?.unavailableScripts[0]?.script).toBe('scripts/py.py');
    expect(demo?.unavailableScripts[0]?.reason).toContain('python3');
  });

  it('marks an instructions-only skill as not executable, which is a working skill', async () => {
    const body = parseToolResult<{ skills: { name: string; executable: boolean }[] }>(
      await harness.callTool('skill_list'),
    );
    expect(body.skills.find((s) => s.name === 'plain')?.executable).toBe(false);
  });
});

describe('skill_load', () => {
  it('returns the SKILL.md body VERBATIM and resolves nothing inside it', async () => {
    const body = parseToolResult<{ body: string; files: { path: string; size: number }[] }>(
      await harness.callTool('skill_load', { name: 'demo' }),
    );
    expect(body.body).toContain('Read references/notes.md for detail.');
    expect(body.body).not.toContain('Some notes.');
    expect(body.files.map((f) => f.path)).toContain('references/notes.md');
  });

  it('refuses an unknown skill, naming the ones it has', async () => {
    const result = await harness.callTool('skill_load', { name: 'nope' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('demo');
  });
});

describe('skill_file', () => {
  it('returns a text file as text', async () => {
    const body = parseToolResult<{ encoding: string; content: string }>(
      await harness.callTool('skill_file', { name: 'demo', path: 'references/notes.md' }),
    );
    expect(body.encoding).toBe('utf-8');
    expect(body.content).toBe('Some notes.\n');
  });

  it('returns a binary file as base64 with its media type', async () => {
    const body = parseToolResult<{ encoding: string; mediaType: string; content: string }>(
      await harness.callTool('skill_file', { name: 'demo', path: 'references/pixel.png' }),
    );
    expect(body.encoding).toBe('base64');
    expect(body.mediaType).toBe('image/png');
    expect(Buffer.from(body.content, 'base64').equals(PNG)).toBe(true);
  });

  it('refuses a path that leaves the skill directory', async () => {
    const result = await harness.callTool('skill_file', { name: 'demo', path: '../plain/SKILL.md' });
    expect(result.isError).toBe(true);
  });
});

describe('skill_run', () => {
  it('is confirm-gated: without confirm it previews and starts no process', async () => {
    const body = parseToolResult<{ dryRun: boolean; willRun: { argv: string[]; cwd: string } }>(
      await harness.callTool('skill_run', { name: 'demo', script: 'scripts/echo.js', args: ['a'] }),
    );
    expect(body.dryRun).toBe(true);
    expect(body.willRun.argv).toEqual(['scripts/echo.js', 'a']);
    expect(body.willRun.cwd).toContain('demo');
  });

  it('runs the script with confirm: true', async () => {
    const body = parseToolResult<{ exitCode: number; stdout: string }>(
      await harness.callTool('skill_run', {
        name: 'demo',
        script: 'scripts/echo.js',
        args: ['x', 'y'],
        confirm: true,
      }),
    );
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe('ran x,y');
  });

  it('refuses an undeclared script even with confirm', async () => {
    const result = await harness.callTool('skill_run', {
      name: 'demo',
      script: 'references/notes.md',
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not declared/i);
  });

  it('previews the refusal too, rather than accepting a call it would refuse', async () => {
    const result = await harness.callTool('skill_run', {
      name: 'demo',
      script: 'references/notes.md',
    });
    expect(result.isError).toBe(true);
  });
});
