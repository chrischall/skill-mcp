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
  const hosted = readEnvVar('MCP_SKILLS_PATH', { env });
  const local = readEnvVar('SKILLS_DIR', { env });

  let roots: string[];
  let rootsFrom: SkillMcpConfig['rootsFrom'];
  if (hosted !== undefined && splitRoots(hosted).length > 0) {
    roots = splitRoots(hosted);
    rootsFrom = 'MCP_SKILLS_PATH';
  } else if (local !== undefined && splitRoots(local).length > 0) {
    roots = splitRoots(local);
    rootsFrom = 'SKILLS_DIR';
  } else {
    roots = [defaultSkillsDir()];
    rootsFrom = 'default';
  }

  const config: SkillMcpConfig = {
    roots: roots.map((root) => resolve(root)),
    rootsFrom,
    grantFrom: 'declaration',
  };

  try {
    const grant = parseGrant(readEnvVar('MCP_SKILL_RUN', { env }));
    if (grant) {
      config.grant = grant;
      config.grantFrom = 'MCP_SKILL_RUN';
    } else if (rootsFrom === 'MCP_SKILLS_PATH') {
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
       * `MCP_SKILLS_PATH` is the runner injecting the roots, so there IS a
       * registration and an owner behind this child, and an absent grant means
       * the owner granted nothing — not that the frontmatter decides. Whoever
       * writes mcp-host's write path must not be able to forget the variable
       * and get a silently wider server; forgetting it here yields one that
       * serves every skill's instructions and runs nothing, which is a working,
       * useful connector and exactly what §7 describes.
       *
       * Standalone use (`SKILLS_DIR`, or the packaged default) keeps
       * declaration-stands: nothing is injecting anything, the person who
       * pointed the server at a directory is the owner, and an empty default
       * there would make `npx @chrischall/skill-mcp` do nothing at all.
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
