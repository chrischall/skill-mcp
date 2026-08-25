/**
 * Path containment — the half of the execution fence that decides WHICH file.
 *
 * Two checks, in this order, and neither is sufficient alone
 * (docs/SKILL-MCP.md §6):
 *
 *  1. **The STRING, before any join.** Plain segments only — no leading `/`,
 *     no `.` or `..` segment, no backslash, no NUL, no percent-encoding. A
 *     resolved-path check alone would have already joined and stat'd something
 *     built out of a shape we never meant to accept.
 *  2. **The RESOLVED real path, after symlinks are followed.** `realpath` on
 *     the candidate and on the skill directory, then a prefix comparison on the
 *     two real paths. A string check alone misses a symlink planted INSIDE the
 *     bundle, which is the case the string never sees: `escape.txt` is a
 *     perfectly ordinary segment whose target is `/etc/shadow`.
 *
 * A symlink that stays inside the skill directory is fine and keeps working —
 * the rule is containment, not "no symlinks".
 */
import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { McpToolError } from '@chrischall/mcp-utils';

/**
 * A path this adapter refuses to resolve. An `McpToolError` so the MCP boundary
 * renders the `hint` (mcp-utils >= 0.15 surfaces it into the failing tool's
 * text) rather than turning a refusal into an opaque stack trace.
 */
export class PathRefusedError extends McpToolError {
  constructor(message: string, hint?: string) {
    super(message, { hint });
    this.name = 'PathRefusedError';
  }
}

/** Longest path this adapter will even look at. Bounds the refusal message too. */
const MAX_PATH_LENGTH = 1024;

/**
 * Why this path is not addressable, or `undefined` when it is.
 *
 * The same rule {@link checkRelativePath} enforces, without the throw, because
 * the MANIFEST has to apply it too: discovery lists a skill's files and the read
 * tools resolve them, and a path listed by one and refused by the other is an
 * inconsistency the caller cannot act on. One function, two callers, so the two
 * cannot drift.
 *
 * Deliberately a positive rule rather than a list of bad substrings: every
 * segment must be a plain one, which is why `%2e%2e`, `C:\…`, a trailing slash
 * and an embedded NUL are all refused without being enumerated.
 */
export function relativePathProblem(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return 'it is empty';
  if (path.length > MAX_PATH_LENGTH) return `it is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.includes('\0')) return 'it contains a NUL byte';
  if (path.includes('\\')) return 'it contains a backslash';
  if (path.includes('%')) return 'it contains a percent escape';

  for (const segment of path.split('/')) {
    if (segment.length === 0) return 'it has an empty segment (leading, trailing or doubled "/")';
    if (segment === '.' || segment === '..') return `it has a "${segment}" segment`;
    if (segment.trim().length === 0) return 'it has a whitespace-only segment';
  }

  return undefined;
}

/**
 * The string check. Returns the path unchanged when it is a plain relative
 * path of ordinary segments; throws {@link PathRefusedError} otherwise.
 */
export function checkRelativePath(path: string): string {
  const why = relativePathProblem(path);
  if (why === undefined) return path;

  const shown = path.length > 120 ? `${path.slice(0, 120)}…` : path;
  throw new PathRefusedError(
    `path ${JSON.stringify(shown)} is not usable: ${why}`,
    'Paths are relative to the skill\'s own directory: plain segments separated by "/", no leading "/", no "." or ".." segment. Call skill_load to see the exact paths this skill bundles.',
  );
}

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * BOTH arguments must already be real paths — this compares strings and
 * follows nothing. Exported because discovery needs the identical rule against
 * a different root: `resolveInsideSkill` takes the SKILL's directory as its
 * containment root, so a skill directory that escaped the configured root is
 * "contained" in the wrong place and every later check agrees with it.
 */
export function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve `relPath` inside `skillDir` and return the real path of a regular
 * file there, or throw {@link PathRefusedError}.
 *
 * `skillDir` is realpath'd too: on macOS `/tmp` is a symlink to `/private/tmp`,
 * so comparing a resolved candidate against an unresolved root refuses every
 * legitimate read on a whole platform.
 */
export async function resolveInsideSkill(skillDir: string, relPath: string): Promise<string> {
  checkRelativePath(relPath);

  const realRoot = await realpath(skillDir).catch(() => {
    throw new PathRefusedError(
      `the skill's directory is not readable`,
      'The skills slot may not have been mounted. Call skill_list to see which roots this server found.',
    );
  });

  const candidate = join(realRoot, relPath);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new PathRefusedError(
      `${JSON.stringify(relPath)} is not a file in this skill`,
      'Call skill_load to see the exact files this skill bundles.',
    );
  }

  if (!isInside(realRoot, resolved)) {
    throw new PathRefusedError(
      `${JSON.stringify(relPath)} resolves outside the skill's own directory`,
      'A file (or a symlink) may only be read from inside the skill it belongs to.',
    );
  }

  // lstat, not stat: `resolved` is already the real path, so anything that is
  // still a link here is a link to a link the kernel refused to follow, and a
  // FIFO or a device is not a thing to read or execute either way.
  const st = await lstat(resolved);
  if (!st.isFile()) {
    throw new PathRefusedError(
      `${JSON.stringify(relPath)} is not a regular file`,
      'Only regular files can be read or executed.',
    );
  }

  return resolved;
}
