/**
 * Wipe this server's exec-time environment block, so a script cannot read the
 * registration's credentials out of `/proc/<ppid>/environ`
 * (chrischall/fleet-audit#244).
 *
 * THE HOLE. A declared script runs as this server's uid, and Linux lets a
 * same-uid, dumpable process read `/proc/<pid>/environ` of another
 * (PTRACE_MODE_READ, which Yama does not restrict). That file is not
 * `process.env`: it is the bytes between `env_start` and `env_end` in this
 * process's address space — the environment block `execve` laid out, holding
 * every credential the registration was started with, whatever `process.env`
 * was edited to afterwards. So the per-script allowlist (`env.ts`) and the
 * owner's grant (`grant.ts`) decided what a script was HANDED while leaving the
 * whole environment one `readFileSync` away.
 *
 * THE FIX, in two steps and in this order:
 *
 *  1. RE-HOME every variable: assign each one back to itself. Node's setter is
 *     `setenv(3)`, which copies `NAME=value` to the heap and repoints
 *     `environ[i]` at the copy — so after this nothing reads the original
 *     block, and `process.env` keeps every value.
 *  2. ZERO the block through `/proc/self/mem` at the range `/proc/self/stat`
 *     reports (fields 50/51, Linux 3.5+). Node has no `prctl`, so this is the
 *     one lever available from inside the process; a write to one's own
 *     writable stack needs no privilege.
 *
 * Then read `/proc/self/environ` back and report whether it is empty.
 *
 * WHAT IT DOES NOT DO. The values still live in this process's heap. Reading
 * them there needs `/proc/<ppid>/mem` or `ptrace`, both PTRACE_MODE_ATTACH,
 * which Yama `ptrace_scope >= 1` refuses to a child for its parent — but a
 * kernel at `ptrace_scope = 0` lets the same uid attach. So this closes the
 * one-line read the audit found; isolation between skills that do not trust
 * each other still belongs to the tier (a distinct uid for scripts,
 * `hidepid=2`, or a non-dumpable server).
 *
 * It never throws: a kernel or sandbox that refuses the write is a reported
 * outcome, and the server boots either way.
 */
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';

/** The injectable surface, so the logic is testable off Linux. */
export interface ScrubIo {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Contents of `/proc/self/stat`. */
  readStat(): string;
  /** Write `bytes` into this process's memory at `offset`. */
  writeMem(offset: number, bytes: Buffer): void;
  /** Contents of `/proc/self/environ`, read back after the write. */
  readEnviron(): Buffer;
}

export type ScrubOutcome =
  | { status: 'unsupported' }
  | { status: 'scrubbed'; bytes: number }
  | { status: 'failed'; reason: string };

/** `env_start` and `env_end`, 1-indexed fields 50 and 51 of `/proc/<pid>/stat`. */
const ENV_START_FIELD = 50;
const ENV_END_FIELD = 51;

/**
 * The environment block's address range, or undefined when the line does not
 * carry a usable one. Fields are counted after the LAST `)`: field 2 is the
 * command name in parentheses, and it may itself contain spaces and `)`.
 */
export function parseEnvRange(stat: string): { start: number; end: number } | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  // What follows ") " is field 3 onward.
  const fields = stat.slice(close + 2).trim().split(' ');
  const start = Number(fields[ENV_START_FIELD - 3]);
  const end = Number(fields[ENV_END_FIELD - 3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if (start <= 0 || end <= start) return undefined;
  return { start, end };
}

function realIo(): ScrubIo {
  return {
    platform: process.platform,
    env: process.env,
    readStat: () => readFileSync('/proc/self/stat', 'latin1'),
    writeMem: (offset, bytes) => {
      const fd = openSync('/proc/self/mem', 'r+');
      try {
        writeSync(fd, bytes, 0, bytes.length, offset);
      } finally {
        closeSync(fd);
      }
    },
    readEnviron: () => readFileSync('/proc/self/environ'),
  };
}

/** Wipe the exec-time environment block. Never throws. */
export function scrubExecEnvironment(io: ScrubIo = realIo()): ScrubOutcome {
  if (io.platform !== 'linux') return { status: 'unsupported' };
  try {
    const range = parseEnvRange(io.readStat());
    if (range === undefined) {
      return { status: 'failed', reason: '/proc/self/stat carries no usable env_start/env_end' };
    }

    // Step 1, and it MUST come first: until every entry is re-homed, getenv
    // reads the very bytes about to be zeroed.
    for (const name of Object.keys(io.env)) {
      io.env[name] = io.env[name];
    }

    const length = range.end - range.start;
    io.writeMem(range.start, Buffer.alloc(length));

    if (io.readEnviron().some((byte) => byte !== 0)) {
      return { status: 'failed', reason: '/proc/self/environ still reads back non-empty after the write' };
    }
    return { status: 'scrubbed', bytes: length };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
