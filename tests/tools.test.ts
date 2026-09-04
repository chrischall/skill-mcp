/**
 * The four tools, driven through the real client RPC path.
 *
 * Tools carry the whole experience (docs/SKILL-MCP.md §2.2): mcp-host's
 * `enabledTools` narrowing names TOOLS, and while it is set `prompts/list` and
 * `resources/list` come back empty and the handshake stops advertising those
 * capabilities — so nothing may be reachable only as a prompt or a resource.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, open, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import {
  registerSkillTools,
  mediaTypeFor,
  MAX_FILE_BYTES,
  MAX_FILE_PATHS,
  MAX_BATCH_BYTES,
} from '../src/tools/skills.js';

let root = '';
let harness: Awaited<ReturnType<typeof createTestHarness>>;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HUGE_BYTES = 256 * 1024 * 1024;

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

  // Declares an "interpreter" that exists only on Object.prototype. A
  // prototype-chain lookup answers with a function and would report the skill
  // as executable; the set has to be closed by the lookup itself.
  const proto = join(root, 'protoonly');
  await mkdir(join(proto, 'scripts'), { recursive: true });
  await writeFile(
    join(proto, 'SKILL.md'),
    [
      '---',
      'name: protoonly',
      'description: Declares an inherited property as its interpreter.',
      'mcp-host:',
      '  version: 1',
      '  run:',
      '    - script: scripts/x.js',
      '      interpreter: constructor',
      '---',
      'x',
      '',
    ].join('\n'),
  );
  await writeFile(join(proto, 'scripts', 'x.js'), `process.stdout.write('never runs')\n`);

  const plain = join(root, 'plain');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'SKILL.md'), '---\nname: plain\ndescription: Instructions only.\n---\nJust text.\n');

  // A bundle carrying one file far larger than skill_file's cap. Sparse, so it
  // costs no disk and no time; §5.3 permits a 256 MiB bundle unpacked, and this
  // is what one large file inside one looks like.
  const bulky = join(root, 'bulky');
  await mkdir(bulky, { recursive: true });
  await writeFile(join(bulky, 'SKILL.md'), '---\nname: bulky\ndescription: Carries a huge file.\n---\nBig.\n');
  const handle = await open(join(bulky, 'huge.bin'), 'w');
  try {
    await handle.truncate(HUGE_BYTES);
  } finally {
    await handle.close();
  }

  // The hosted shape: the roots injected by the runner AND the owner's grant
  // supplied explicitly. Without `MCP_SKILL_RUN` a hosted server grants NOTHING
  // (config.ts) — pinned by "the hosted default" test below.
  const deps = await createDeps({
    MCP_SKILLS_PATH: root,
    MCP_SKILL_RUN: JSON.stringify([{ skill: 'demo', script: 'scripts/echo.js' }]),
  });
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

  it('does not treat an inherited property name as an interpreter this deployment runs', async () => {
    const body = parseToolResult<{
      skills: {
        name: string;
        executable: boolean;
        scripts: unknown[];
        unavailableScripts: { script: string; reason: string }[];
      }[];
    }>(await harness.callTool('skill_list'));

    const proto = body.skills.find((s) => s.name === 'protoonly');
    expect(proto?.executable).toBe(false);
    expect(proto?.scripts).toEqual([]);
    expect(proto?.unavailableScripts[0]?.script).toBe('scripts/x.js');
    expect(proto?.unavailableScripts[0]?.reason).toContain('constructor');
  });
});

describe('media types', () => {
  it('answers only for extensions it actually maps, never an inherited one', () => {
    expect(mediaTypeFor('notes.md')).toBe('text/markdown');
    expect(mediaTypeFor('x.constructor')).toBe('application/octet-stream');
    expect(mediaTypeFor('x.toString')).toBe('application/octet-stream');
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

/** One entry of a `skill_file` batch, as the tool returns it. */
interface FileEntry {
  path: string;
  size?: number;
  mediaType?: string;
  encoding?: string;
  truncated?: boolean;
  content?: string;
  error?: string;
}

const readFiles = async (name: string, paths: string[]): Promise<FileEntry[]> =>
  parseToolResult<{ files: FileEntry[] }>(await harness.callTool('skill_file', { name, paths }))
    .files;

describe('skill_file', () => {
  it('returns a text file as text', async () => {
    const [entry] = await readFiles('demo', ['references/notes.md']);
    expect(entry!.encoding).toBe('utf-8');
    expect(entry!.content).toBe('Some notes.\n');
  });

  it('returns a binary file as base64 with its media type', async () => {
    const [entry] = await readFiles('demo', ['references/pixel.png']);
    expect(entry!.encoding).toBe('base64');
    expect(entry!.mediaType).toBe('image/png');
    expect(Buffer.from(entry!.content!, 'base64').equals(PNG)).toBe(true);
  });

  it('refuses a path that leaves the skill directory', async () => {
    // Per ENTRY, not as a failed call: the refusal is the path's, and a sibling
    // read in the same batch is unaffected by it.
    const [escaped, sibling] = await readFiles('demo', [
      '../plain/SKILL.md',
      'references/notes.md',
    ]);
    // The STRING check fires first and names the reason, so this never reaches
    // the resolve — which is the order paths.ts documents.
    expect(escaped!.error).toMatch(/".." segment/);
    expect(escaped!.content).toBeUndefined();
    expect(sibling!.content).toBe('Some notes.\n');
  });

  it('reads several files in ONE call, in the order they were asked for', async () => {
    // The reason the tool takes a list at all: a SKILL.md points at several
    // files, and a caller pairs entry N with the path it asked for at N.
    const entries = await readFiles('demo', ['references/pixel.png', 'references/notes.md']);
    expect(entries.map((e) => e.path)).toEqual(['references/pixel.png', 'references/notes.md']);
    expect(entries[0]!.encoding).toBe('base64');
    expect(entries[1]!.content).toBe('Some notes.\n');
  });

  it('reports a missing file as that entry\'s error and still serves the rest', async () => {
    const [missing, present] = await readFiles('demo', ['references/gone.md', 'references/notes.md']);
    expect(missing!.error).toMatch(/not a file in this skill/);
    expect(present!.content).toBe('Some notes.\n');
  });

  it('refuses more paths than the per-call limit', async () => {
    const tooMany = Array.from({ length: MAX_FILE_PATHS + 1 }, () => 'references/notes.md');
    const result = await harness.callTool('skill_file', { name: 'demo', paths: tooMany });
    expect(result.isError).toBe(true);
  });

  it('refuses a batch whose reads would exceed the call total, before reading any of them', async () => {
    // Four capped reads of the huge file plan 4 MiB, which is the total; five
    // plan 5 MiB and must be refused WHOLE — there is no per-entry slot for a
    // budget the call as a whole blew. Sizing is from stat, so nothing is read.
    const under = await harness.callTool('skill_file', {
      name: 'bulky',
      paths: Array.from({ length: 4 }, () => 'huge.bin'),
    });
    expect(under.isError).not.toBe(true);

    const over = await harness.callTool('skill_file', {
      name: 'bulky',
      paths: Array.from({ length: 5 }, () => 'huge.bin'),
    });
    expect(over.isError).toBe(true);
    expect(JSON.stringify(over)).toMatch(/over this call's/);
  });

  it('sizes the batch by what it would SERVE, not by the files\' real sizes', async () => {
    // huge.bin is HUGE_BYTES on disk and MAX_FILE_BYTES served. Summing the
    // real sizes would refuse this call; summing the served bytes admits it.
    expect(HUGE_BYTES * 4).toBeGreaterThan(MAX_BATCH_BYTES);
    const entries = await readFiles('bulky', Array.from({ length: 4 }, () => 'huge.bin'));
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.truncated === true)).toBe(true);
  });

  it('caps a huge file, reports the truncation, and names the real size', async () => {
    const [entry] = await readFiles('bulky', ['huge.bin']);
    expect(entry!.size).toBe(HUGE_BYTES);
    expect(entry!.truncated).toBe(true);
    expect(Buffer.from(entry!.content!, 'base64').byteLength).toBe(MAX_FILE_BYTES);
  });

  it('ALLOCATES no more than the cap while serving that read', async () => {
    // The cap exists to bound the child's heap (docs/SKILL-MCP.md §2.1), and a
    // hosted child gets RLIMIT_DATA 256 MiB hard. Asserting only `truncated`
    // above passes against a whole-file read, which is how this shipped once.
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    };
    const timer = setInterval(sample, 2);
    let result;
    try {
      result = await harness.callTool('skill_file', { name: 'bulky', paths: ['huge.bin'] });
    } finally {
      clearInterval(timer);
    }
    sample();

    expect(result.isError).not.toBe(true);
    // The base64 string and its round-trip check cost a few MiB on top of the
    // 1 MiB read; a whole-file read costs 256 MiB.
    expect(peak - before).toBeLessThan(32 * 1024 * 1024);
  });
});

describe('the hosted default grant', () => {
  it('grants NOTHING when the roots came from the runner and no grant was set', async () => {
    // docs/SKILL-MCP.md §7: "A registration created without this field executes
    // nothing." One child holds one environment holding every credential the
    // owner set, so a skill naming its neighbour's variable in its OWN
    // frontmatter must not be handed the neighbour's credential.
    const deps = await createDeps({ MCP_SKILLS_PATH: root });
    const local = await createTestHarness((server) => registerSkillTools(server, deps));
    try {
      const body = parseToolResult<{
        grantFrom: string;
        grantNote?: string;
        skills: { name: string; executable: boolean; scripts: unknown[]; ungrantedScripts?: unknown[] }[];
      }>(await local.callTool('skill_list'));

      const demo = body.skills.find((s) => s.name === 'demo');
      expect(body.grantFrom).toBe('hosted-default');
      expect(body.grantNote).toMatch(/MCP_SKILL_RUN/);
      expect(demo?.executable).toBe(false);
      expect(demo?.scripts).toEqual([]);
      // Reported, not merely absent: a skill that declares a script and cannot
      // run it here must not look like a skill that declared nothing.
      expect(demo?.ungrantedScripts).toHaveLength(1);

      const run = await local.callTool('skill_run', {
        name: 'demo',
        script: 'scripts/echo.js',
        confirm: true,
      });
      expect(run.isError).toBe(true);
      expect(JSON.stringify(run.content)).toMatch(/not declared|not granted/i);
    } finally {
      await local.close();
    }
  });

  it('still lets a standalone run (SKILLS_DIR) fall back to the declaration', async () => {
    // Nobody is injecting anything there, so the skill's own declaration is the
    // only statement of intent that exists — and the person who pointed the
    // server at the directory is the owner.
    const deps = await createDeps({ SKILLS_DIR: root });
    const local = await createTestHarness((server) => registerSkillTools(server, deps));
    try {
      const body = parseToolResult<{ grantFrom: string; skills: { name: string; scripts: unknown[] }[] }>(
        await local.callTool('skill_list'),
      );
      expect(body.grantFrom).toBe('declaration');
      expect(body.skills.find((s) => s.name === 'demo')?.scripts).toHaveLength(1);
    } finally {
      await local.close();
    }
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

  // Every response here is minified, the confirm-gated run receipt included.
  // That is safe for exactly one reason: `minifiedResult` drops the JSON INDENT
  // and the runs after `:` and `,` — it never reaches inside a string — so a
  // script's own stdout, blank lines and all, survives byte-for-byte. A
  // hand-rolled minifier (a regex over the serialised text, a collapse of
  // `\s+`) would corrupt exactly the payload this tool exists to return.
  it('minifies the run receipt without touching the script output inside it', async () => {
    const shaped = 'line one.\n\n    indented.   ';
    const raw = await harness.callTool('skill_run', {
      name: 'demo',
      script: 'scripts/echo.js',
      args: [shaped],
      confirm: true,
    });
    const text = (raw as { content: Array<{ text: string }> }).content[0].text;
    // None of OUR whitespace: the serialised receipt is a single line.
    expect(text.split('\n')).toHaveLength(1);
    // All of the SCRIPT's: the newlines and the trailing run of spaces survive.
    expect(parseToolResult<{ stdout: string }>(raw).stdout).toBe(`ran ${shaped}`);
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
