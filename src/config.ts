/**
 * Where the skills are, and what may run.
 *
 * Two names, and the precedence is deliberate:
 *
 *  - **`MCP_SKILLS_PATH`** — a colon-separated list of slot roots, the variable
 *    mcp-host's runner constructs and injects the way it injects `MCP_DATA_DIR`
 *    and `MCP_HOST_METER_FILE` (docs/SKILL-MCP.md §5.3). It is a RESERVED name
 *    there: a registration may not set it, because re-pointing it aims the
 *    adapter at any directory in the tree — another registration's slot, the
 *    install tree, `$HOME`.
 *  - **`SKILLS_DIR`** — the same thing for someone running this server from a
 *    terminal or an MCP client, where no host is injecting anything. Read only
 *    when `MCP_SKILLS_PATH` is unset, so a hosted deployment's value can never
 *    be shadowed by one a registration's plain `env` supplies.
 *
 * With neither set the default is this package's own `skills/` directory, which
 * is what makes `npx @chrischall/skill-mcp` do something on the first run.
 */
import { dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvVar } from '@chrischall/mcp-utils';
import { parseGrant, type Grant } from './grant.js';

/**
 * Variables mcp-host's runner INJECTS into a child it started (supervisor.ts's
 * `buildChildEnv` injections, and `MCP_SKILLS_PATH` when the skills slot lands).
 * Their presence is what says "a runner is on the other side of this process",
 * and it is read for ONE decision: the default grant (below).
 *
 * It is a heuristic, and it is only ever allowed to move that default in the
 * FAIL-CLOSED direction — a marker that is absent leaves the behaviour exactly
 * as it would have been. That is what makes it safe to guess with: the failure
 * of a false positive is a hosted-looking server that runs nothing until its
 * owner grants something, and the failure of a false negative is the window
 * this closes.
 *
 * The window: mcp-host does not inject `MCP_SKILLS_PATH` yet
 * (docs/SKILL-MCP.md §5.3 leaves it to a later task), so today the only channel
 * that can point a hosted registration at a bundle is `SKILLS_DIR` in its plain
 * `env` — and reading "hosted" off `MCP_SKILLS_PATH` alone put exactly that
 * registration on the declaration-stands default, inside a child holding the
 * owner's credentials.
 */
const HOST_INJECTED_MARKERS = [
  'MCP_SKILLS_PATH',
  'MCP_HOST_METER_FILE',
  'MCP_DATA_DIR',
  'MCP_BLOB_BASE_URL',
] as const;

/** How this server was configured, resolved once at boot. */
export interface SkillMcpConfig {
  /** Absolute roots to scan, in order. */
  roots: string[];
  /** Which variable supplied them — reported by `skill_list`, since "no skills" has several causes. */
  rootsFrom: 'MCP_SKILLS_PATH' | 'SKILLS_DIR' | 'default';
  /** The owner's grant, when there is one. Narrow-only (`grant.ts`). */
  grant?: Grant;
  /** Where the grant came from — reported by `skill_list`, since "nothing runs" has two causes. */
  grantFrom: 'MCP_SKILL_RUN' | 'hosted-default' | 'declaration';
  /** True when a runner-injected variable says this child was started by a host. */
  hosted: boolean;
  /** A grant that was set but unreadable. Surfaced rather than silently ignored. */
  grantError?: string;
}

/** `<package>/skills`, resolved from this module rather than from `cwd`. */
export function defaultSkillsDir(moduleUrl: string = import.meta.url): string {
  // dist/config.js → dist → <package>; src/config.ts → src → <package>. The
  // esbuild bundle lands at dist/bundle.js, so it resolves the same way.
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', 'skills');
}

function splitRoots(value: string): string[] {
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Resolve the configuration. Never throws: a broken `MCP_SKILL_RUN` becomes
 * `grantError` and grants nothing, which is the safe direction, and an
 * unreadable root becomes a discovery problem rather than a boot failure — the
 * deferred-config-error pattern, so the host's install-time `tools/list` probe
 * still succeeds.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SkillMcpConfig {
  const injectedRoots = readEnvVar('MCP_SKILLS_PATH', { env });
  const local = readEnvVar('SKILLS_DIR', { env });

  let roots: string[];
  let rootsFrom: SkillMcpConfig['rootsFrom'];
  if (injectedRoots !== undefined && splitRoots(injectedRoots).length > 0) {
    roots = splitRoots(injectedRoots);
    rootsFrom = 'MCP_SKILLS_PATH';
  } else if (local !== undefined && splitRoots(local).length > 0) {
    roots = splitRoots(local);
    rootsFrom = 'SKILLS_DIR';
  } else {
    roots = [defaultSkillsDir()];
    rootsFrom = 'default';
  }

  // Not "which variable supplied the roots": ANY injected marker means a
  // runner started this child, and therefore that a registration and an owner
  // sit behind it (HOST_INJECTED_MARKERS, above).
  const hosted = HOST_INJECTED_MARKERS.some(
    (name) => readEnvVar(name, { env }) !== undefined,
  );

  const config: SkillMcpConfig = {
    roots: roots.map((root) => resolve(root)),
    rootsFrom,
    grantFrom: 'declaration',
    hosted,
  };

  try {
    const grant = parseGrant(readEnvVar('MCP_SKILL_RUN', { env }));
    if (grant) {
      config.grant = grant;
      config.grantFrom = 'MCP_SKILL_RUN';
    } else if (hosted) {
      /*
       * The DEFAULT is per caller, and the hosted half is fail-CLOSED.
       *
       * docs/SKILL-MCP.md §7: *"Empty by default. A registration created
       * without this field executes nothing"* — and the reason is the sentence
       * before it. One child holds one environment holding every credential the
       * owner set for the registration, so a skill whose own frontmatter names
       * its NEIGHBOUR's variable would be handed the neighbour's credential
       * with nothing anywhere having decided to give it. Letting the
       * declaration stand there is that inverted.
       *
       * A runner-injected marker means there IS a registration and an owner
       * behind this child, and an absent grant means the owner granted nothing
       * — not that the frontmatter decides. It is deliberately not
       * `MCP_SKILLS_PATH` alone: that variable is not injected yet, so the only
       * hosted channel today (`SKILLS_DIR` in a registration's plain `env`)
       * would otherwise land on the declaration-stands default. Whoever
       * writes mcp-host's write path must not be able to forget the variable
       * and get a silently wider server; forgetting it here yields one that
       * serves every skill's instructions and runs nothing, which is a working,
       * useful connector and exactly what §7 describes.
       *
       * Standalone use keeps declaration-stands — no marker is present at all,
       * nothing is injecting anything, the person who pointed the server at a
       * directory is the owner, and an empty default there would make `npx
       * @chrischall/skill-mcp` do nothing at all.
       */
      config.grant = { entries: [] };
      config.grantFrom = 'hosted-default';
    }
  } catch (err) {
    // A grant that cannot be read grants NOTHING — never everything. The two
    // are opposite answers and only one of them is safe to guess.
    config.grant = { entries: [] };
    config.grantFrom = 'MCP_SKILL_RUN';
    config.grantError = err instanceof Error ? err.message : String(err);
  }

  return config;
}
