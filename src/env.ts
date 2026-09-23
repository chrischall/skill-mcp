/**
 * The environment a declared script is HANDED — an allowlist in two halves
 * (docs/SKILL-MCP.md §6).
 *
 * **This is not hygiene.** `perUserChild` is unavailable on the isolated tier,
 * so one skill registration is one child holding one environment holding every
 * credential its owner set. A script that inherited that environment would
 * read the API key belonging to the skill next door — and a script whose own
 * frontmatter could name that variable would read it just as effectively,
 * which is why the declaration NARROWS and the owner GRANTS.
 *
 * **What it is NOT: a credential boundary against a hostile script.** The
 * script is spawned as the SAME uid as this server (`src/run.ts`: no uid drop,
 * no namespace, no seccomp here), and Linux lets a same-uid, dumpable process
 * read `/proc/<ppid>/environ` — which holds this server's ORIGINAL exec-time
 * environment, every credential included, however `process.env` is edited
 * afterwards. So the allowlist decides what a well-behaved script is HANDED;
 * it cannot stop a script written to go looking. Isolation between skills that
 * do not trust each other has to come from the tier — a distinct uid for
 * scripts, `/proc` mounted `hidepid=2`, or a non-dumpable server — and until
 * the host provides one, a registration should carry only skills whose owner
 * would hand each of them every credential it holds (chrischall/fleet-audit#244).
 *
 * The precedent is `packages/runner-node/src/spawn-env.ts` in mcp-host, and it
 * is worth quoting precisely because half of it is easy to misquote:
 *
 *   const INSTALL_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'] as const;
 *
 * That is a fixed HOST constant which a registration's declared `build` cannot
 * widen by one name — the model for the first half here, and the OPPOSITE of
 * the second, where names ARE added and therefore somebody other than the
 * skill's author has to add them.
 */
import { RESERVED_SCRIPT_ENV } from './frontmatter.js';

/**
 * The fixed half. Copied from the adapter's own environment when set, and not
 * widenable by anything a skill declares. Byte-identical to `spawn-env.ts`'s
 * `INSTALL_ALLOWLIST`, and `tests/run.test.ts` pins that.
 */
export const AMBIENT_SCRIPT_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'] as const;

/**
 * Host-computed values a script may see beyond the ambient set. `MCP_DATA_DIR`
 * is the writable directory a script is supposed to use, since the bundle slot
 * is read-only (§5.3) — naming it in the failure is the adapter's job, so
 * handing it over is the other half of that.
 */
export const INJECTED_SCRIPT_ENV = ['MCP_DATA_DIR'] as const;

/**
 * Build a script's environment: the ambient allowlist, the injected names, and
 * exactly the granted names — nothing else, and never the adapter's own
 * environment wholesale.
 *
 * A granted name the host itself sets is dropped here as well as at
 * declaration time. Two checks on purpose: a check that exists in one place is
 * a check the next edit can delete.
 */
export function buildScriptEnv(
  granted: readonly string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const name of [...AMBIENT_SCRIPT_ALLOWLIST, ...INJECTED_SCRIPT_ENV]) {
    const value = sourceEnv[name];
    if (typeof value === 'string') env[name] = value;
  }

  for (const name of granted) {
    if (RESERVED_SCRIPT_ENV.has(name)) continue;
    const value = sourceEnv[name];
    if (typeof value === 'string') env[name] = value;
  }

  return env;
}
