// Invariant: the tool tables in README.md and CLAUDE.md name exactly the
// arguments each registered tool takes over tools/list; README's preview and
// problem-reason tables name exactly the fields and reasons the code emits.
//
// The bug it guards (chrischall/fleet-audit#1120): skill_file grew from one
// `path` to a `paths[]` batch, CLAUDE.md was updated and the README — the file
// npm and the marketplace show — kept documenting `path`, so a reader called
// the tool with an argument name the schema rejects.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { createDeps } from '../src/deps.js';
import { PROBLEM_REASONS } from '../src/discovery.js';
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

/**
 * The backticked first-column names of the markdown table that follows
 * `heading` in README.md (up to the next heading). Empty when the heading is
 * missing, so a deleted section fails the comparison rather than the parser.
 */
function tableNamesUnder(heading: string): string[] {
  const lines = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    const match = /^\|\s*`([A-Za-z-]+)`\s*\|/.exec(line);
    if (match) names.push(match[1]!);
  }
  return names.sort();
}

function sectionUnder(heading: string): string {
  const text = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length + 1);
  const end = rest.search(/^#/m);
  return end === -1 ? rest : rest.slice(0, end);
}

// The preview is part of the confirmToken payload, so a client that renders or
// compares it depends on its field set (auto-review follow-up #55: `envWarning`
// arrived undocumented, and `envNames` widened from "granted" to "handed").
describe('documented skill_run preview fields', () => {
  let envRoot = '';

  beforeAll(async () => {
    envRoot = await realpath(await mkdtemp(join(tmpdir(), 'skill-docs-')));
    const dir = join(envRoot, 'needs-key');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: needs-key',
        'description: Declares one set and one unset variable.',
        'mcp-host:',
        '  version: 1',
        '  run:',
        '    - script: scripts/env.js',
        '      interpreter: node',
        '      env: [API_KEY, MISSING_KEY]',
        '---',
        'x',
        '',
      ].join('\n'),
    );
    await writeFile(join(dir, 'scripts', 'env.js'), `process.stdout.write('ok');\n`);
  });

  afterAll(async () => {
    if (envRoot) await rm(envRoot, { recursive: true, force: true });
  });

  it("README's preview table names every field a preview can carry, optional ones included", async () => {
    // Standalone, one declared variable set and one not: the shape that emits
    // every optional field (`envNotSet` AND `envWarning`) at once.
    const local = await createTestHarness(async (server) =>
      registerSkillTools(
        server,
        await createDeps({ SKILLS_DIR: envRoot, PATH: '/usr/bin:/bin', API_KEY: 'secret' }),
      ),
    );
    try {
      const body = parseToolResult<{ preview: { willRun: Record<string, unknown> } }>(
        await local.callTool('skill_run', { name: 'needs-key', script: 'scripts/env.js' }),
      );
      const fields = Object.keys(body.preview.willRun).sort();
      expect(fields).toContain('envNotSet');
      expect(fields).toContain('envWarning');
      expect(tableNamesUnder('### The `skill_run` preview')).toEqual(fields);
    } finally {
      await local.close();
    }
  });

  it('says envNames lists every variable handed over, the ambient allowlist included', () => {
    const section = sectionUnder('### The `skill_run` preview');
    for (const name of ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR', 'MCP_DATA_DIR']) {
      expect(section, name).toContain(`\`${name}\``);
    }
  });
});

describe('documented skill_list problem reasons', () => {
  it("README's reason table names exactly the reasons discovery can report", () => {
    expect(tableNamesUnder('### Problem reasons')).toEqual([...PROBLEM_REASONS].sort());
  });

  it('tells clients the reason set grows, so an unknown one must not break them', () => {
    expect(sectionUnder('### Problem reasons')).toMatch(/additive/i);
  });
});
