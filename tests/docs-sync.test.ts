// Invariant: the tool tables in README.md and CLAUDE.md name exactly the
// arguments each registered tool takes over tools/list.
//
// The bug it guards (chrischall/fleet-audit#1120): skill_file grew from one
// `path` to a `paths[]` batch, CLAUDE.md was updated and the README — the file
// npm and the marketplace show — kept documenting `path`, so a reader called
// the tool with an argument name the schema rejects.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import { registerSkillTools } from '../src/tools/skills.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `tool -> sorted argument names` from the first markdown table whose rows
 * start with a backticked `skill_*` tool. `paths[]` is read as `paths`.
 */
function documentedArgs(file: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
    const match = /^\|\s*`(skill_[a-z]+)`\s*\|([^|]*)\|/.exec(line);
    if (!match) continue;
    const args = [...match[2]!.matchAll(/`([A-Za-z]+)(?:\[\])?`/g)].map((m) => m[1]!).sort();
    rows.set(match[1]!, args);
  }
  return rows;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeAll(async () => {
  const deps = await createDeps({});
  harness = await createTestHarness((server) => registerSkillTools(server, deps));
});

afterAll(async () => {
  await harness?.close();
});

describe('documented tool arguments', () => {
  for (const file of ['README.md', 'CLAUDE.md']) {
    it(`${file}'s tool table matches every registered input schema`, async () => {
      const registered = new Map(
        (await harness.client.listTools()).tools.map((tool) => [
          tool.name,
          Object.keys(tool.inputSchema.properties ?? {}).sort(),
        ]),
      );
      const documented = documentedArgs(file);
      expect([...documented.keys()].sort()).toEqual([...registered.keys()].sort());
      for (const [tool, args] of registered) {
        expect(documented.get(tool), `${file}: ${tool}`).toEqual(args);
      }
    });
  }
});
