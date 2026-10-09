/**
 * The server's shared state: the resolved config, the catalog it scanned, and
 * the one-run-at-a-time lock.
 *
 * Built by the CALLER (`index.ts`) and threaded through the registrars, which
 * is what preserves the deferred-config-error pattern: nothing here throws when
 * the roots are missing or the grant is unreadable, so the server still boots
 * and answers a host's install-time `tools/list` probe. What went wrong comes
 * back from `skill_list` as a problem, where somebody can read it.
 *
 * The catalog is scanned ONCE. When hosted, the slot is read-only and pinned by
 * `configHash`, so nothing under it can change while the child lives; the
 * prompt and resource projections are registered from this same snapshot, and a
 * catalog that changed underneath them would leave the two surfaces disagreeing.
 */
import { discoverSkills, type Catalog, type DiscoveredSkill } from './discovery.js';
import { applyGrant } from './grant.js';
import { loadConfig, type SkillMcpConfig } from './config.js';
import { createRunLock, type RunLock } from './run.js';
import type { ScrubOutcome } from './scrub-environ.js';
import { readEnvVar } from '@chrischall/mcp-utils';

/**
 * Set to `1` by an owner who accepts running scripts in a HOSTED child whose
 * exec-time environment block could not be wiped (`scrub-environ.ts`).
 */
export const ALLOW_UNSCRUBBED_VAR = 'MCP_SKILL_ALLOW_UNSCRUBBED';

/** Everything the tool registrars need. */
export interface SkillMcpDeps {
  config: SkillMcpConfig;
  catalog: Catalog;
  lock: RunLock;
  /** The environment scripts are built from — injectable so tests never touch the real one. */
  sourceEnv: NodeJS.ProcessEnv;
  /**
   * Why `skill_run` refuses every script, when it does: a hosted child whose
   * exec-time environment block is still readable at `/proc/<ppid>/environ`.
   */
  runBlocked?: string;
  skill(name: string): DiscoveredSkill | undefined;
}

/** Scan the configured roots and build the deps. Never throws for bad input. */
export async function createDeps(
  env: NodeJS.ProcessEnv = process.env,
  scrub?: ScrubOutcome,
): Promise<SkillMcpDeps> {
  const config = loadConfig(env);
  const catalog = applyGrant(await discoverSkills(config.roots), config.grant);
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
  const runBlocked = unscrubbedRefusal(config.hosted, scrub, env);
  if (runBlocked !== undefined) {
    catalog.problems.push({ path: '/proc/self/environ', reason: 'environ-unscrubbed', detail: runBlocked });
  }

  return {
    config,
    catalog,
    lock: createRunLock(),
    sourceEnv: env,
    ...(runBlocked !== undefined ? { runBlocked } : {}),
    skill: (name) => byName.get(name),
  };
}

/**
 * The scrub never throws, so its failure has to be CARRIED somewhere or it is
 * a stderr line nobody reads (chrischall/fleet-audit#1121). Hosted, a failed
 * scrub silently restores the hole it exists to close — every script the
 * registration runs could read every credential the owner set — so it is
 * fail-CLOSED there, like every other hosted default (`config.ts`), unless the
 * owner opts in by name. Standalone stays open: the person who started the
 * server and the person whose environment it is are the same person.
 */
function unscrubbedRefusal(
  hosted: boolean,
  scrub: ScrubOutcome | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!hosted || scrub?.status !== 'failed') return undefined;
  if (readEnvVar(ALLOW_UNSCRUBBED_VAR, { env }) === '1') return undefined;
  return `the exec-time environment block could not be wiped (${scrub.reason}), so any script could read every variable this registration holds from /proc/<ppid>/environ; no script may run until that is fixed, or until the owner sets ${ALLOW_UNSCRUBBED_VAR}=1 to accept it`;
}
