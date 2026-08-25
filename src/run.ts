/**
 * `skill_run` — executing a script a skill DECLARES, and nothing else.
 *
 * The rules, each of which is a narrowing (docs/SKILL-MCP.md §6):
 *
 *  - only a script the skill declares (intersected with the owner's grant when
 *    one was supplied — see `grant.ts`);
 *  - the resolved real path must stay inside that skill's own directory
 *    (`paths.ts` — the string check AND the resolve-and-re-check, because a
 *    declaration can name a symlink);
 *  - an argv ARRAY, never a shell string: `spawn` with `shell: false` and no
 *    interpolation anywhere. A shell string is how "run this declared script"
 *    becomes "run anything", and no feature here needs one;
 *  - an interpreter from a closed set, named per script in the declaration,
 *    never inferred from the extension and never taken from the file's own
 *    shebang — a file that can choose its own interpreter has already chosen
 *    its own program;
 *  - bounded, and the CALL always returns: a wall-clock timeout, a per-stream
 *    output cap with the truncation REPORTED, one run at a time, and the
 *    process GROUP signalled on timeout rather than the leader alone. The group
 *    kill reaches a cooperating tree and nothing else — a grandchild that
 *    detached into its own group survives it AND holds the stdio pipes, so the
 *    run settles on the process EXITING (plus a short drain) under a hard
 *    deadline, never on the pipes closing. That is what bounds the tool call
 *    and frees the one-at-a-time lock; it is not a claim that the grandchild
 *    is dead, which is the tier's job (§6.2), not this module's;
 *  - an env allowlist (`env.ts`);
 *  - `cwd` is the skill's directory, which is read-only when hosted.
 *
 * **What none of this buys**: a declared script is still arbitrary code. The
 * fence that matters is the tier — a microVM per registration, an unprivileged
 * uid, prlimit bounds, nftables default-deny. This module is a narrowing on top
 * of that fence, and it is not a sandbox (§6.2).
 */
import { spawn } from 'node:child_process';
import { McpToolError } from '@chrischall/mcp-utils';
import type { DiscoveredSkill } from './discovery.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './frontmatter.js';
import { buildScriptEnv } from './env.js';
import { resolveInsideSkill } from './paths.js';

/**
 * The interpreters this deployment can run, and it is deliberately ONE.
 *
 * The mcp-host runner image is Node 22 + git + tar + util-linux + nftables and
 * nothing else — no python3, no curl, no jq. Skills are not written that way
 * (70 `.py` against 1 `.js` in `anthropics/skills` at `3b3fad96`), so this set
 * is a measured refusal rather than an oversight: a declared script naming
 * anything else is refused with the interpreter and this set in the message,
 * and the skill's INSTRUCTIONS still serve. A pinned interpreter arrives as a
 * dependency, never as an image change (docs/SKILL-MCP.md §6.1).
 */
export const INTERPRETERS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, { node: process.execPath }),
);

/**
 * The lookup, and it is a FUNCTION rather than an index read on purpose.
 *
 * `INTERPRETERS[name]` walks the prototype chain, so on an ordinary object
 * literal `constructor` and `toString` both answer with a function and a skill
 * declaring `interpreter: constructor` passes a `!interpreterPath` gate — it is
 * then reported as runnable, previewed as runnable, and stopped only by
 * `spawn`'s own argument type check, which is an incidental downstream
 * behaviour rather than this fence. The null-prototype object above closes the
 * set; this function is the second of the two, so a later edit that swaps the
 * literal back cannot silently reopen it.
 */
export function interpreterPathFor(name: string): string | undefined {
  return Object.hasOwn(INTERPRETERS, name) ? INTERPRETERS[name] : undefined;
}

/** True when this deployment can actually run scripts declaring `name`. */
export function isRunnableInterpreter(name: string): boolean {
  return interpreterPathFor(name) !== undefined;
}

/** The set, for a refusal message. */
export function interpreterNames(): string[] {
  return Object.keys(INTERPRETERS);
}

/** Per-stream capture cap. Truncation is reported, never silent (§6). */
export const MAX_STREAM_BYTES = 1024 * 1024;

/** Bounds on the argv array itself. */
export const MAX_ARGS = 64;
export const MAX_ARG_BYTES = 8 * 1024;

/** Grace between the process group's SIGTERM and its SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * How long the run waits for the pipes AFTER the process itself has exited.
 * Re-armed by each chunk that arrives in the window, so an actively draining
 * stream is not cut short.
 */
const DRAIN_MS = 250;

/** Headroom on the hard deadline, over the timeout + kill grace + drain. */
const HARD_DEADLINE_SLACK_MS = 1_000;

/** A call this adapter refuses to make. Distinct from a script that ran and failed. */
export class RunRefusedError extends McpToolError {
  constructor(message: string, hint?: string) {
    super(message, { hint });
    this.name = 'RunRefusedError';
  }
}

/** One `skill_run` at a time per server, held by the caller rather than by this module. */
export interface RunLock {
  busy: boolean;
}

/** Create a lock. Lives on the server's deps so nothing here holds mutable module state. */
export function createRunLock(): RunLock {
  return { busy: false };
}

/** What one execution produced. A non-zero exit is a RESULT, never an exception. */
export interface RunResult {
  skill: string;
  script: string;
  interpreter: string;
  /** `null` when the process was killed rather than exiting. */
  exitCode: number | null;
  /** The signal that killed it, when one did. */
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
  timeoutMs: number;
  durationMs: number;
  /** The names actually handed to the script — never their values. */
  env: string[];
  /** Set when the host's environment says this machine's network is fenced. */
  networkNote?: string;
}

/** Everything one execution needs. `sourceEnv` is injectable so tests never touch the real one. */
export interface RunOptions {
  skill: DiscoveredSkill;
  script: string;
  args: string[];
  lock: RunLock;
  sourceEnv?: NodeJS.ProcessEnv;
}

const NETWORK_NOTE =
  "This MCP's network is restricted to a declared egress allowlist. A host that is not on it appears either as an HTTP 403 from the loopback proxy or as a connection timeout — the two are indistinguishable from inside the script. If this failure looks like a network failure, the fix is the registration's egress policy, not the script.";

/** True when the environment says this machine sits behind the isolated tier's proxy. */
function fencedNetwork(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
}

function checkArgs(args: string[]): void {
  if (args.length > MAX_ARGS) {
    throw new RunRefusedError(
      `too many arguments: ${args.length}, the cap is ${MAX_ARGS}`,
      'Pass fewer arguments, or have the script read a file from MCP_DATA_DIR.',
    );
  }
  let total = 0;
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new RunRefusedError('every argument must be a string');
    }
    if (arg.includes('\0')) {
      throw new RunRefusedError('an argument contains a NUL byte');
    }
    total += Buffer.byteLength(arg);
  }
  if (total > MAX_ARG_BYTES) {
    throw new RunRefusedError(
      `arguments total ${total} bytes, over the ${MAX_ARG_BYTES}-byte cap`,
      'Pass a path rather than a payload.',
    );
  }
}

/** Collects a stream up to the cap, remembering that it stopped. */
class CappedStream {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (this.size >= MAX_STREAM_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_STREAM_BYTES - this.size;
    if (chunk.byteLength > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = MAX_STREAM_BYTES;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Run one declared script. Throws {@link RunRefusedError} or `PathRefusedError`
 * when the call is refused; resolves with a {@link RunResult} for everything
 * the script itself did, including failing.
 */
export async function runDeclaredScript(opts: RunOptions): Promise<RunResult> {
  const { lock } = opts;
  const sourceEnv = opts.sourceEnv ?? process.env;

  // Taken SYNCHRONOUSLY, before the first `await`: acquiring it after the path
  // resolution would let two calls that arrived in the same tick both pass the
  // check, which is exactly the concurrency this bound exists to refuse.
  if (lock.busy) {
    throw new RunRefusedError(
      'another skill_run is already in flight on this server',
      'Wait for it to finish; this server runs one script at a time.',
    );
  }
  lock.busy = true;
  try {
    return await execute(opts, sourceEnv);
  } finally {
    lock.busy = false;
  }
}

/** The body of one run, with the lock already held. */
async function execute(opts: RunOptions, sourceEnv: NodeJS.ProcessEnv): Promise<RunResult> {
  const { skill, script, args } = opts;

  // `skill.scripts`, never `skill.declaration.run`: the effective list is the
  // declaration already intersected with the owner's grant (`grant.ts`).
  const declared = skill.scripts.find((entry) => entry.script === script);
  if (!declared) {
    const offered = skill.scripts.map((entry) => entry.script);
    throw new RunRefusedError(
      `"${script}" is not declared as a runnable script by the skill "${skill.name}"`,
      offered.length > 0
        ? `This skill declares: ${offered.join(', ')}. Only a script named in SKILL.md's "mcp-host.run" block may run.`
        : 'This skill declares no runnable scripts. A script becomes runnable by being named in SKILL.md\'s "mcp-host.run" block and accepted at registration.',
    );
  }

  const interpreterPath = interpreterPathFor(declared.interpreter);
  if (interpreterPath === undefined) {
    throw new RunRefusedError(
      `"${script}" declares the interpreter "${declared.interpreter}", which this deployment cannot run; it runs: ${interpreterNames().join(', ')}`,
      "The skill's instructions are still available through skill_load — only its scripts are unavailable here.",
    );
  }

  checkArgs(args);

  // Both halves of the containment check, in order (paths.ts). A declaration
  // may name a symlink, so the string check alone is not enough.
  const target = await resolveInsideSkill(skill.dir, script);

  const env = buildScriptEnv(declared.env, sourceEnv);
  const timeoutMs = Math.min(declared.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const started = Date.now();

  return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(interpreterPath, [target, ...args], {
        cwd: skill.dir,
        env,
        // shell:false is the rule, spelled rather than defaulted.
        shell: false,
        // Its own process group, so a timeout reaches a cooperating tree rather
        // than the leader alone. It does NOT reach a grandchild that detached
        // into a group of its own — see the settle rule below, which is what
        // actually bounds the call.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const out = new CappedStream();
      const err = new CappedStream();
      let timedOut = false;
      let settled = false;
      let exited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let drainTimer: NodeJS.Timeout | undefined;

      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* already gone */
          }
        }
      };

      /**
       * Settle once, from whichever of the three paths gets there first.
       *
       * The streams are destroyed here rather than left to close on their own:
       * a detached grandchild can hold the write end of this pipe for as long
       * as it likes, and an undestroyed read end keeps a handle (and this
       * promise's `finally`, which frees the one-at-a-time lock) alive with it.
       */
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hard);
        if (drainTimer) clearTimeout(drainTimer);
        // A SIGKILL of the group can outlive the leader; make sure nothing that
        // stayed in the group is left.
        if (timedOut) killGroup('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();

        const failed = timedOut || exitCode !== 0;
        resolve({
          skill: skill.name,
          script,
          interpreter: declared.interpreter,
          exitCode,
          signal: exitSignal,
          stdout: out.text(),
          stderr: err.text(),
          truncated: { stdout: out.truncated, stderr: err.truncated },
          timedOut,
          timeoutMs,
          durationMs: Date.now() - started,
          env: Object.keys(env).sort(),
          ...(failed && fencedNetwork(sourceEnv) ? { networkNote: NETWORK_NOTE } : {}),
        });
      };

      /**
       * After the process itself is gone, wait only this long for whatever the
       * pipes still hold. Re-armed by each chunk that arrives, so a stream that
       * is genuinely still delivering is not cut off — and bounded from above
       * by `hard`, so nothing here can extend the call indefinitely.
       */
      const drain = (): void => {
        if (drainTimer) clearTimeout(drainTimer);
        drainTimer = setTimeout(finish, DRAIN_MS);
        drainTimer.unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);
      timer.unref();

      // The last word, and the reason the tool call is bounded at all: `close`
      // waits for the stdio pipes rather than for the process, so a grandchild
      // that detached into its own group can hold them open past every kill we
      // are able to send. Without this the promise never settles, the tool call
      // never returns, and the lock released in its `finally` is never released
      // — one call permanently denying `skill_run` for the life of the server.
      const hard = setTimeout(() => {
        timedOut = true;
        killGroup('SIGKILL');
        finish();
      }, timeoutMs + KILL_GRACE_MS + DRAIN_MS + HARD_DEADLINE_SLACK_MS);
      hard.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        out.push(chunk);
        if (exited) drain();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        err.push(chunk);
        if (exited) drain();
      });

      child.on('error', (spawnErr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hard);
        if (drainTimer) clearTimeout(drainTimer);
        reject(
          new RunRefusedError(
            `could not start "${script}": ${spawnErr.message}`,
            'The interpreter this deployment runs is node; the script must be a regular file in the skill.',
          ),
        );
      });

      // 'exit' is the process; 'close' is the pipes. The process is what the
      // exit code and the timeout are about, so it is what starts the clock.
      child.on('exit', (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal ?? null;
        drain();
      });

      // The fast path: everything the child owned is closed, so there is
      // nothing left to wait for.
      child.on('close', (code, signal) => {
        if (!exited) {
          exitCode = code;
          exitSignal = signal ?? null;
        }
        finish();
      });
  });
}
