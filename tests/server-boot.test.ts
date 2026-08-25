/**
 * Boot the REAL built artifacts and drive the handshake.
 *
 * Two runtimes, because they fail differently and unit tests see neither:
 *
 *  - `dist/bundle.js` in a temp directory with NO `node_modules` — the `.mcpb`
 *    runtime. An eager top-level import of an esbuild-`--external` dependency
 *    throws `ERR_MODULE_NOT_FOUND` the moment a host spawns it, before
 *    `initialize`, and the host logs "Server transport closed unexpectedly"
 *    rather than anything useful.
 *  - the `bin` entry `dist/index.js` WITH `node_modules` — the npm/`npx`
 *    runtime, where a wrong `rootDir` puts the entry at `dist/src/index.js` and
 *    nothing can find it.
 *
 * The tool count is asserted as `>= 4`, never exactly: PR CI runs the branch
 * merged with `main`, so a hardcoded count breaks the instant another PR adds a
 * tool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const BIN = join(ROOT, 'dist', 'index.js');

let sandbox = '';

/** One JSON-RPC exchange over a freshly spawned server, closed afterwards. */
async function handshake(entry: string, cwd: string, env: NodeJS.ProcessEnv) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'boot-test', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skill_list', arguments: {} } });

  const deadline = Date.now() + 20_000;
  const responses: Record<number, { result?: Record<string, unknown>; error?: unknown }> = {};
  while (Date.now() < deadline) {
    for (const line of stdout.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
        if (typeof message.id === 'number') responses[message.id] = message;
      } catch {
        /* a partial line; the next poll sees the rest */
      }
    }
    if (responses[1] && responses[2] && responses[3]) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill('SIGTERM');
  return { responses, stderr, exitCode: child.exitCode };
}

beforeAll(async () => {
  if (!existsSync(BUNDLE) || !existsSync(BIN)) {
    throw new Error('run `npm run build` before this test — it drives the built artifacts');
  }
  sandbox = await mkdtemp(join(tmpdir(), 'skill-boot-'));
  // The .mcpb runtime: the bundle, a package.json declaring ESM, the skills
  // directory beside it — and NO node_modules.
  await cp(BUNDLE, join(sandbox, 'bundle.js'));
  await writeFile(join(sandbox, 'package.json'), JSON.stringify({ type: 'module' }));
  await mkdir(join(sandbox, 'skills'), { recursive: true });
  await cp(join(ROOT, 'skills'), join(sandbox, 'skills'), { recursive: true });
}, 60_000);

afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe('dist/bundle.js — the .mcpb runtime, no node_modules', () => {
  it('answers initialize and tools/list', async () => {
    const { responses, stderr } = await handshake(join(sandbox, 'bundle.js'), sandbox, {
      SKILLS_DIR: join(sandbox, 'skills'),
    });

    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(responses[1]?.result?.serverInfo).toMatchObject({ name: 'skill-mcp' });

    const tools = (responses[2]?.result?.tools ?? []) as { name: string }[];
    expect(tools.length).toBeGreaterThanOrEqual(4);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['skill_list', 'skill_load', 'skill_file', 'skill_run']),
    );
  }, 40_000);

  it('serves the bundled example skill through a real tool call', async () => {
    const { responses } = await handshake(join(sandbox, 'bundle.js'), sandbox, {
      SKILLS_DIR: join(sandbox, 'skills'),
    });
    const content = (responses[3]?.result?.content ?? []) as { text?: string }[];
    const body = JSON.parse(content[0]?.text ?? '{}') as {
      skills: { name: string; executable: boolean; scripts: { script: string }[] }[];
    };
    const demo = body.skills.find((s) => s.name === 'skill-mcp-demo');
    expect(demo?.executable).toBe(true);
    expect(demo?.scripts.map((s) => s.script)).toEqual(['scripts/report.js']);
  }, 40_000);
});

describe('dist/index.js — the npm bin, with node_modules', () => {
  it('answers initialize and tools/list from the package root', async () => {
    const { responses, stderr } = await handshake(BIN, ROOT, {});
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(responses[1]?.result?.serverInfo).toMatchObject({ name: 'skill-mcp' });
    const tools = (responses[2]?.result?.tools ?? []) as { name: string }[];
    expect(tools.length).toBeGreaterThanOrEqual(4);
  }, 40_000);

  it('defaults to the package\'s own skills/ directory when nothing points it elsewhere', async () => {
    const { responses } = await handshake(BIN, ROOT, {});
    const content = (responses[3]?.result?.content ?? []) as { text?: string }[];
    const body = JSON.parse(content[0]?.text ?? '{}') as {
      rootsFrom: string;
      skills: { name: string }[];
    };
    expect(body.rootsFrom).toBe('default');
    expect(body.skills.map((s) => s.name)).toContain('skill-mcp-demo');
  }, 40_000);
});
