/**
 * The execution fence (docs/SKILL-MCP.md §6). Every rule below is a narrowing,
 * and each has its own test because a fence with one untested rule is a fence
 * with one rule.
 *
 * What none of it buys is stated in §6.2 and repeated in the README: a declared
 * script is still arbitrary code. These tests pin WHICH code runs and WITH
 * WHAT — never that the code is safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathRefusedError } from '../src/paths.js';
import { AMBIENT_SCRIPT_ALLOWLIST, buildScriptEnv } from '../src/env.js';
import {
  INTERPRETERS,
  MAX_STREAM_BYTES,
  RunRefusedError,
  runDeclaredScript,
  createRunLock,
} from '../src/run.js';
import type { DiscoveredSkill } from '../src/discovery.js';
import { discoverSkills } from '../src/discovery.js';

let root = '';
let catalogSkills: DiscoveredSkill[] = [];

const skillOf = (name: string): DiscoveredSkill => {
  const found = catalogSkills.find((s) => s.name === name);
  if (!found) throw new Error(`fixture skill ${name} missing`);
  return found;
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-run-')));

  const demo = join(root, 'demo');
  await mkdir(join(demo, 'scripts'), { recursive: true });
  await writeFile(
    join(demo, 'SKILL.md'),
    [
      '---',
      'name: demo',
      'description: A fixture skill.',
      'mcp-host:',
      '  version: 1',
      '  run:',
      '    - script: scripts/echo.js',
      '      interpreter: node',
      '      env: [DEMO_TOKEN]',
      '    - script: scripts/fail.js',
      '      interpreter: node',
      '    - script: scripts/spin.js',
      '      interpreter: node',
      '      timeout: 1',
      '    - script: scripts/flood.js',
      '      interpreter: node',
      '    - script: scripts/py.py',
      '      interpreter: python3',
      '---',
      'Instructions.',
      '',
    ].join('\n'),
  );

  await writeFile(
    join(demo, 'scripts', 'echo.js'),
    `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), cwd: process.cwd() }));\n`,
  );
  await writeFile(
    join(demo, 'scripts', 'fail.js'),
    `process.stdout.write('partial output\\n'); process.stderr.write('the reason\\n'); process.exit(3);\n`,
  );
  await writeFile(
    join(demo, 'scripts', 'spin.js'),
    `setInterval(() => {}, 1000); process.stdout.write('started\\n');\n`,
  );
  await writeFile(
    join(demo, 'scripts', 'flood.js'),
    `const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 40; i += 1) process.stdout.write(chunk);\n`,
  );
  await writeFile(join(demo, 'scripts', 'py.py'), `print("never runs")\n`);
  // Present in the bundle, deliberately NOT declared.
  await writeFile(join(demo, 'scripts', 'undeclared.js'), `process.stdout.write('ran')\n`);
  await chmod(join(demo, 'scripts', 'undeclared.js'), 0o755);

  // A script the declaration names but which leaves the tree by symlink.
  await writeFile(join(root, 'outside.js'), `process.stdout.write('escaped')\n`);
  await symlink(join(root, 'outside.js'), join(demo, 'scripts', 'escape.js'));

  const escaper = join(root, 'escaper');
  await mkdir(join(escaper, 'scripts'), { recursive: true });
  await writeFile(
    join(escaper, 'SKILL.md'),
    [
      '---',
      'name: escaper',
      'description: Declares a script that is a symlink out of the tree.',
      'mcp-host:',
      '  version: 1',
      '  run:',
      '    - script: scripts/escape.js',
      '      interpreter: node',
      '---',
      'x',
      '',
    ].join('\n'),
  );
  await symlink(join(root, 'outside.js'), join(escaper, 'scripts', 'escape.js'));

  catalogSkills = (await discoverSkills([root])).skills;
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const run = (
  skill: DiscoveredSkill,
  script: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) => runDeclaredScript({ skill, script, args, lock: createRunLock(), sourceEnv: env });

describe('rule: only a DECLARED script may run', () => {
  it('refuses a file that is in the bundle but not declared, and says it must be declared', async () => {
    await expect(run(skillOf('demo'), 'scripts/undeclared.js')).rejects.toThrow(RunRefusedError);
    await run(skillOf('demo'), 'scripts/undeclared.js').catch((err: RunRefusedError) => {
      expect(err.message).toMatch(/not declared/i);
      expect(err.hint).toMatch(/mcp-host/);
    });
  });

  it('refuses a declared-looking path that is not in the declaration', async () => {
    await expect(run(skillOf('demo'), 'scripts/echo.mjs')).rejects.toThrow(RunRefusedError);
  });

  it('runs a declared script', async () => {
    const result = await run(skillOf('demo'), 'scripts/echo.js');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).cwd).toBe(skillOf('demo').dir);
  });
});

describe('rule: the resolved path stays inside the skill directory', () => {
  it('refuses a traversal string before it touches the filesystem', async () => {
    await expect(run(skillOf('demo'), '../escaper/scripts/escape.js')).rejects.toThrow(
      RunRefusedError,
    );
  });

  it('refuses an absolute path', async () => {
    await expect(run(skillOf('demo'), '/bin/sh')).rejects.toThrow(RunRefusedError);
  });

  it('refuses a DECLARED script that is a symlink out of the tree', async () => {
    // The declaration names it, so only the resolve-and-re-check catches this.
    await expect(run(skillOf('escaper'), 'scripts/escape.js')).rejects.toThrow(PathRefusedError);
  });
});

describe('rule: an argv array, never a shell string', () => {
  it('passes arguments through verbatim, with no shell to interpret them', async () => {
    const result = await run(skillOf('demo'), 'scripts/echo.js', ['; touch pwned', '$(whoami)', '|| ls']);
    expect(JSON.parse(result.stdout).argv).toEqual(['; touch pwned', '$(whoami)', '|| ls']);
  });

  it('refuses an argument containing a NUL byte', async () => {
    await expect(run(skillOf('demo'), 'scripts/echo.js', ['a\0b'])).rejects.toThrow(RunRefusedError);
  });

  it('refuses more arguments than the cap', async () => {
    await expect(
      run(skillOf('demo'), 'scripts/echo.js', new Array(200).fill('a')),
    ).rejects.toThrow(RunRefusedError);
  });
});

describe('rule: an interpreter from a closed set', () => {
  it('refuses an interpreter this deployment cannot run, naming the set', async () => {
    await run(skillOf('demo'), 'scripts/py.py').then(
      () => {
        throw new Error('should have refused');
      },
      (err: RunRefusedError) => {
        expect(err).toBeInstanceOf(RunRefusedError);
        expect(err.message).toContain('python3');
        expect(err.message).toContain('node');
      },
    );
  });

  it('offers exactly one interpreter in v1', () => {
    expect(Object.keys(INTERPRETERS)).toEqual(['node']);
  });
});

describe('rule: the env allowlist', () => {
  it('hands a script the ambient set plus only its GRANTED names', async () => {
    const result = await run(skillOf('demo'), 'scripts/echo.js', [], {
      PATH: '/usr/bin',
      HOME: '/home/child',
      DEMO_TOKEN: 'granted',
      NEIGHBOUR_API_KEY: 'must not be handed over',
      MCP_HOST_METER_FILE: '/data/meter',
    });
    const env: string[] = JSON.parse(result.stdout).env;
    expect(env).toContain('DEMO_TOKEN');
    expect(env).toContain('PATH');
    expect(env).not.toContain('NEIGHBOUR_API_KEY');
    expect(env).not.toContain('MCP_HOST_METER_FILE');
  });

  it('mirrors the runner\'s INSTALL_ALLOWLIST for the ambient half', () => {
    // packages/runner-node/src/spawn-env.ts: ['PATH','HOME','LANG','TZ','TMPDIR']
    expect([...AMBIENT_SCRIPT_ALLOWLIST]).toEqual(['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR']);
  });

  it('passes MCP_DATA_DIR through when the host set one', () => {
    const env = buildScriptEnv([], { MCP_DATA_DIR: '/data/state/x', SECRET: 's' });
    expect(env.MCP_DATA_DIR).toBe('/data/state/x');
    expect(env.SECRET).toBeUndefined();
  });

  it('never hands over a granted name the host reserves', () => {
    const env = buildScriptEnv(['MCP_SKILLS_PATH'], { MCP_SKILLS_PATH: '/slots/a' });
    expect(env.MCP_SKILLS_PATH).toBeUndefined();
  });

  it('omits a granted name the environment does not hold', () => {
    const env = buildScriptEnv(['DEMO_TOKEN'], {});
    expect('DEMO_TOKEN' in env).toBe(false);
  });
});

describe('rule: bounded', () => {
  it('reports a non-zero exit as a normal outcome, keeping the output', async () => {
    const result = await run(skillOf('demo'), 'scripts/fail.js');
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('partial output');
    expect(result.stderr).toContain('the reason');
    expect(result.timedOut).toBe(false);
  });

  it('kills a script that outruns its timeout and says so', async () => {
    const result = await run(skillOf('demo'), 'scripts/spin.js');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain('started');
    expect(result.durationMs).toBeLessThan(30_000);
  }, 20_000);

  it('caps captured output and REPORTS the truncation rather than cutting silently', async () => {
    const result = await run(skillOf('demo'), 'scripts/flood.js');
    expect(result.truncated.stdout).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_STREAM_BYTES);
  }, 20_000);

  it('runs one script at a time per server', async () => {
    const lock = createRunLock();
    const first = runDeclaredScript({
      skill: skillOf('demo'),
      script: 'scripts/spin.js',
      args: [],
      lock,
      sourceEnv: {},
    });
    await expect(
      runDeclaredScript({
        skill: skillOf('demo'),
        script: 'scripts/echo.js',
        args: [],
        lock,
        sourceEnv: {},
      }),
    ).rejects.toThrow(RunRefusedError);
    await first;
  }, 20_000);
});

describe('the restricted-network note', () => {
  it('is attached to a failure when the host set proxy variables', async () => {
    const result = await run(skillOf('demo'), 'scripts/fail.js', [], {
      HTTPS_PROXY: 'http://127.0.0.1:3128',
    });
    expect(result.networkNote).toMatch(/egress/i);
  });

  it('is absent when nothing suggests a restricted network', async () => {
    const result = await run(skillOf('demo'), 'scripts/fail.js');
    expect(result.networkNote).toBeUndefined();
  });
});
