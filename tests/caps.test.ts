/**
 * The read-side caps (docs/SKILL-MCP.md §2.1): `skill_load` serves at most
 * 256 KiB of SKILL.md and `skill_file` at most 1 MiB of a file's bytes, and
 * each answers `truncated: true` rather than cutting silently — the same rule
 * `skill_run` follows for its output, because it is the same question.
 *
 * `skill_file`'s is the one that has to exist: it returns base64, so an
 * uncapped read inflates a binary by a third into a JSON-RPC frame built in
 * this process's heap and streamed to the caller.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import { registerSkillTools, MAX_FILE_BYTES } from '../src/tools/skills.js';
import { MAX_SKILL_MD_BYTES } from '../src/discovery.js';

let root = '';
let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-caps-')));
  const big = join(root, 'big');
  await mkdir(big, { recursive: true });

  await writeFile(
    join(big, 'SKILL.md'),
    `---\nname: big\ndescription: Oversized on purpose.\n---\n${'x'.repeat(MAX_SKILL_MD_BYTES)}\n`,
  );
  await writeFile(join(big, 'huge.bin'), Buffer.alloc(MAX_FILE_BYTES + 4096, 0));
  await writeFile(join(big, 'small.txt'), 'fits\n');

  const deps = await createDeps({ MCP_SKILLS_PATH: root });
  harness = await createTestHarness((server) => registerSkillTools(server, deps));
});

afterAll(async () => {
  await harness?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('skill_load', () => {
  it('caps the body and REPORTS the truncation', async () => {
    const body = parseToolResult<{ body: string; truncated: boolean; truncationNote?: string }>(
      await harness.callTool('skill_load', { name: 'big' }),
    );
    expect(body.truncated).toBe(true);
    expect(body.truncationNote).toContain(String(MAX_SKILL_MD_BYTES));
    expect(Buffer.byteLength(body.body)).toBeLessThan(MAX_SKILL_MD_BYTES);
  });
});

interface CappedEntry {
  truncated: boolean;
  size: number;
  encoding: string;
  content: string;
  truncationNote?: string;
}

const read = async (name: string, paths: string[]): Promise<CappedEntry[]> =>
  parseToolResult<{ files: CappedEntry[] }>(await harness.callTool('skill_file', { name, paths }))
    .files;

describe('skill_file', () => {
  it('caps a file and REPORTS the truncation, with the real size', async () => {
    const [entry] = await read('big', ['huge.bin']);

    expect(entry!.truncated).toBe(true);
    expect(entry!.size).toBe(MAX_FILE_BYTES + 4096);
    expect(entry!.encoding).toBe('base64');
    expect(Buffer.from(entry!.content, 'base64').byteLength).toBe(MAX_FILE_BYTES);
    expect(entry!.truncationNote).toContain(String(MAX_FILE_BYTES));
  });

  it('does not claim truncation for a file that fits', async () => {
    const [entry] = await read('big', ['small.txt']);
    expect(entry!.truncated).toBe(false);
    expect(entry!.content).toBe('fits\n');
  });

  it('reports truncation PER ENTRY, so a batch says which read was cut', async () => {
    // The whole point of a per-entry flag: a batch that reported one
    // `truncated` for the call could not say which file it referred to.
    const [huge, small] = await read('big', ['huge.bin', 'small.txt']);
    expect(huge!.truncated).toBe(true);
    expect(small!.truncated).toBe(false);
    expect(small!.content).toBe('fits\n');
  });
});
