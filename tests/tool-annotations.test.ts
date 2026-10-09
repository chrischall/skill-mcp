/**
 * Every tool's annotations, read off the REGISTERED surface over tools/list
 * rather than a hand-kept list — a new tool that forgets to classify itself
 * fails here instead of publishing silence.
 *
 * `destructiveHint` defaults to TRUE whenever `readOnlyHint` is false, so a
 * write that omits it is indistinguishable from one that chose it; and an
 * absent `openWorldHint` defaults to true, which would call a pure local file
 * read a network tool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import { registerSkillTools } from '../src/tools/skills.js';

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let root = '';
let harness: Awaited<ReturnType<typeof createTestHarness>>;
let ann: Record<string, Ann>;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-ann-')));
  await mkdir(join(root, 'demo'), { recursive: true });
  await writeFile(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nbody\n');
  const deps = await createDeps({ MCP_SKILLS_PATH: root });
  harness = await createTestHarness((server) => registerSkillTools(server, deps));
  ann = Object.fromEntries(
    (await harness.client.listTools()).tools.map((t) => [t.name, (t.annotations ?? {}) as Ann]),
  );
});

afterAll(async () => {
  await harness?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('every tool is annotated truthfully', () => {
  it('covers the full surface (guards against the meta-test going blind)', () => {
    expect(Object.keys(ann).sort()).toEqual(['skill_file', 'skill_list', 'skill_load', 'skill_run']);
  });

  it('sets an explicit boolean readOnlyHint on every tool', () => {
    const missing = Object.entries(ann)
      .filter(([, a]) => typeof a.readOnlyHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(ann)
      .filter(([, a]) => a.readOnlyHint === false && typeof a.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(ann)
      .filter(([, a]) => a.readOnlyHint === true && a.destructiveHint === true)
      .map(([n]) => n);
    expect(contradictory).toEqual([]);
  });

  it('sets an explicit boolean openWorldHint on every tool', () => {
    const missing = Object.entries(ann)
      .filter(([, a]) => typeof a.openWorldHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('marks the local file reads closed-world and skill_run open-world', () => {
    // list/load/file only read the skill directories on local disk.
    for (const name of ['skill_list', 'skill_load', 'skill_file']) {
      expect(ann[name]?.openWorldHint, name).toBe(false);
    }
    // A declared script is opaque to this adapter by construction and may
    // reach anything — same reasoning as its destructiveHint.
    expect(ann['skill_run']).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
});
