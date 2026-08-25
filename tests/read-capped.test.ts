/**
 * The cap has to bound the ALLOCATION, not only the answer.
 *
 * docs/SKILL-MCP.md §2.1 gives the reason `skill_file`'s cap exists: *"an
 * uncapped read inflates a binary by a third into a JSON-RPC frame built in the
 * child's heap"*. A `readFile` followed by a `subarray` bounds the frame and
 * allocates the whole file first, which on the tier this adapter is designed for
 * is fatal rather than wasteful — mcp-host gives a hosted child RLIMIT_DATA
 * 256 MiB soft AND hard (CLAUDE.md, `rlimits.ts`) while §5.3 permits a 256 MiB
 * bundle, so a large bundled file would kill the child on first read and again
 * on every respawn. The content is third-party by construction ("bring your own
 * skill"), so it is reachable from a bundle nobody in this repo wrote.
 *
 * The assertions below are therefore about MEMORY as well as bytes. A test that
 * only checks `truncated: true` passes against the broken implementation — that
 * is exactly how the broken one shipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCapped } from '../src/read-capped.js';

const HUGE = 256 * 1024 * 1024;
const CAP = 1024 * 1024;

let dir = '';
let huge = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-read-capped-'));
  huge = join(dir, 'huge.bin');
  // Sparse: `truncate` costs no disk and no time, and reads back as zeroes.
  const handle = await open(huge, 'w');
  try {
    await handle.truncate(HUGE);
  } finally {
    await handle.close();
  }
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('readCapped', () => {
  it('returns a small file whole, untruncated, with its real size', async () => {
    const path = join(dir, 'small.txt');
    await writeFile(path, 'hello');
    const read = await readCapped(path, CAP);
    expect(read.bytes.toString('utf8')).toBe('hello');
    expect(read.size).toBe(5);
    expect(read.truncated).toBe(false);
  });

  it('returns exactly the cap and reports the truncation', async () => {
    const read = await readCapped(huge, CAP);
    expect(read.bytes.byteLength).toBe(CAP);
    expect(read.truncated).toBe(true);
    expect(read.size).toBe(HUGE);
  });

  it('does not truncate a file that is exactly the cap', async () => {
    const path = join(dir, 'exact.bin');
    await writeFile(path, Buffer.alloc(64, 0x61));
    const read = await readCapped(path, 64);
    expect(read.bytes.byteLength).toBe(64);
    expect(read.truncated).toBe(false);
  });

  it('ALLOCATES no more than the cap — the property the cap exists for', async () => {
    // `arrayBuffers` is where a Buffer's bytes live, so a whole-file read shows
    // up here at full size and stays there while the slice keeps its parent
    // alive. Sampled during the await as well as after it, because the read is
    // one libuv operation that yields the loop.
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    };
    const timer = setInterval(sample, 2);
    let read;
    try {
      read = await readCapped(huge, CAP);
    } finally {
      clearInterval(timer);
    }
    sample();

    // Keep the result alive so nothing here is measuring a collection.
    expect(read.bytes.byteLength).toBe(CAP);
    // Generous by 30x against the cap and 8x under the file: the broken
    // implementation lands at +256 MiB, the fixed one at about +1 MiB.
    expect(peak - before).toBeLessThan(32 * 1024 * 1024);
  });
});
