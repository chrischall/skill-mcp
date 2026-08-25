/**
 * Reading a bounded prefix of a file — the one read primitive this adapter uses.
 *
 * Every cap in docs/SKILL-MCP.md §2.1 (`skill_load`'s 256 KiB of SKILL.md,
 * `skill_file`'s 1 MiB of a bundled file) exists for a reason the doc states
 * plainly: *"an uncapped read inflates a binary by a third into a JSON-RPC frame
 * built in the child's heap"*. `readFile` followed by a slice satisfies the
 * letter of that — the FRAME is bounded — and misses the point entirely, because
 * the whole file is in the heap before the slice happens.
 *
 * That distinction is fatal rather than academic on the tier this adapter is
 * designed for. mcp-host gives a hosted child RLIMIT_DATA 256 MiB, soft AND hard
 * (`packages/runner-node/src/rlimits.ts`), while §5.3 permits a skills bundle of
 * 256 MiB unpacked. A single large bundled file — and the bundle is third-party
 * by construction, since the whole feature is "bring your own skill" — would
 * therefore kill the MCP child on the first read, and again on every respawn.
 *
 * So: `stat` for the real size, then read at most `maxBytes + 1` bytes. The one
 * extra byte is what decides `truncated` without a second syscall and without
 * trusting `st.size`, which is a lie on procfs and stale on a file being
 * appended to.
 */
import { open } from 'node:fs/promises';

/** A bounded read: at most `maxBytes` of a file, plus what was cut. */
export interface CappedRead {
  /** At most `maxBytes`. */
  bytes: Buffer;
  /** The file's real size, so a truncation can be reported with a number. */
  size: number;
  /** True when the file held more than `maxBytes`. */
  truncated: boolean;
}

/**
 * Read at most `maxBytes` bytes from `path`.
 *
 * Throws whatever `open`/`read` throws — a caller that wants a missing file to
 * be a refusal resolves the path first (`resolveInsideSkill`), which is where
 * containment is decided anyway.
 */
export async function readCapped(path: string, maxBytes: number): Promise<CappedRead> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();

    // One byte past the cap: reading it means the file is bigger than the cap,
    // which is `truncated` without asking the filesystem a second time.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let read = 0;
    while (read <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, read, maxBytes + 1 - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }

    const truncated = read > maxBytes;
    return {
      // Never the raw buffer: the bytes past `read` are uninitialised memory
      // from `allocUnsafe` and must not reach a tool result.
      bytes: buffer.subarray(0, Math.min(read, maxBytes)),
      // `st.size` for a regular file; what was actually read when the
      // filesystem reports something smaller (procfs reports 0 for real
      // content), so `size` is never less than the bytes being returned.
      size: Math.max(stat.size, read),
      truncated,
    };
  } finally {
    await handle.close();
  }
}
