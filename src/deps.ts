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

/** Everything the tool registrars need. */
export interface SkillMcpDeps {
  config: SkillMcpConfig;
  catalog: Catalog;
  lock: RunLock;
  /** The environment scripts are built from — injectable so tests never touch the real one. */
  sourceEnv: NodeJS.ProcessEnv;
  skill(name: string): DiscoveredSkill | undefined;
}

/** Scan the configured roots and build the deps. Never throws for bad input. */
export async function createDeps(env: NodeJS.ProcessEnv = process.env): Promise<SkillMcpDeps> {
  const config = loadConfig(env);
  const catalog = applyGrant(await discoverSkills(config.roots), config.grant);
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));

  return {
    config,
    catalog,
    lock: createRunLock(),
    sourceEnv: env,
    skill: (name) => byName.get(name),
  };
}
