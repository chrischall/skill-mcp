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

describe('skill_file', () => {
  it('caps a file and REPORTS the truncation, with the real size', async () => {
    const body = parseToolResult<{
      truncated: boolean;
      size: number;
      encoding: string;
      content: string;
      truncationNote?: string;
    }>(await harness.callTool('skill_file', { name: 'big', path: 'huge.bin' }));

    expect(body.truncated).toBe(true);
    expect(body.size).toBe(MAX_FILE_BYTES + 4096);
    expect(body.encoding).toBe('base64');
    expect(Buffer.from(body.content, 'base64').byteLength).toBe(MAX_FILE_BYTES);
    expect(body.truncationNote).toContain(String(MAX_FILE_BYTES));
  });

  it('does not claim truncation for a file that fits', async () => {
    const body = parseToolResult<{ truncated: boolean; content: string }>(
      await harness.callTool('skill_file', { name: 'big', path: 'small.txt' }),
    );
    expect(body.truncated).toBe(false);
    expect(body.content).toBe('fits\n');
  });
});
