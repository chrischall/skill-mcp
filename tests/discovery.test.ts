/**
 * Discovery has to be robust in a specific way: one bad skill directory may
 * never cost the listing. A directory with no SKILL.md is SKIPPED with a
 * reason, malformed frontmatter is reported per skill, and a name collision is
 * reported rather than silently shadowing (docs/SKILL-MCP.md §2.1's uniqueness
 * rule, enforced here as a report because the adapter is downstream of the
 * resolve that should have refused it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, MAX_SKILLS } from '../src/discovery.js';

let root = '';

const skill = async (dir: string, frontmatter: string, body = 'Instructions.\n'): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-discovery-')));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('layouts', () => {
  it('finds `<root>/<name>/SKILL.md`', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: The alpha skill.');
    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['alpha']);
    expect(found.skills[0]?.description).toBe('The alpha skill.');
    expect(found.problems).toEqual([]);
  });

  it('finds a bundle whose SKILL.md is at the root itself', async () => {
    await skill(root, 'name: solo\ndescription: One skill, no wrapper directory.');
    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['solo']);
  });

  it('finds `<root>/skills/<name>/SKILL.md`', async () => {
    await skill(join(root, 'skills', 'beta'), 'name: beta\ndescription: b');
    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['beta']);
  });

  it('reads several roots and records which one each skill came from', async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), 'skill-discovery-b-')));
    try {
      await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
      await skill(join(other, 'beta'), 'name: beta\ndescription: b');
      const found = await discoverSkills([root, other]);
      expect(found.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
      expect(found.skills[0]?.root).toBe(root);
      expect(found.skills[1]?.root).toBe(other);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('reports a root that does not exist rather than throwing', async () => {
    const found = await discoverSkills([join(root, 'nope')]);
    expect(found.skills).toEqual([]);
    expect(found.problems[0]?.reason).toBe('root-unreadable');
  });
});

describe('robustness', () => {
  it('skips a directory with no SKILL.md, with a reported reason', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await mkdir(join(root, 'notaskill', 'nested'), { recursive: true });
    await writeFile(join(root, 'notaskill', 'readme.md'), 'hi');

    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['alpha']);
    const problem = found.problems.find((p) => p.path.endsWith('notaskill'));
    expect(problem?.reason).toBe('no-skill-md');
    expect(problem?.detail).toMatch(/SKILL\.md/);
  });

  it('reports malformed frontmatter per skill and keeps listing the others', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await skill(join(root, 'broken'), 'name: [unclosed');
    await skill(join(root, 'zeta'), 'name: zeta\ndescription: z');

    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    const problem = found.problems.find((p) => p.path.endsWith('broken'));
    expect(problem?.reason).toBe('malformed-frontmatter');
  });

  it('reports a name collision instead of silently shadowing', async () => {
    await skill(join(root, 'one'), 'name: dup\ndescription: first');
    await skill(join(root, 'two'), 'name: dup\ndescription: second');

    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['dup']);
    expect(found.skills[0]?.description).toBe('first');
    const problem = found.problems.find((p) => p.reason === 'duplicate-name');
    expect(problem).toBeDefined();
    expect(problem?.detail).toContain('dup');
    expect(problem?.detail).toContain('one');
  });

  it('falls back to the directory name when the frontmatter names none', async () => {
    await skill(join(root, 'unnamed'), 'description: no name key');
    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['unnamed']);
  });

  it('reports a frontmatter name that disagrees with its directory', async () => {
    await skill(join(root, 'onthedisk'), 'name: inthefile\ndescription: d');
    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['inthefile']);
    expect(found.problems.find((p) => p.reason === 'name-mismatch')).toBeDefined();
  });

  it('refuses a name that is not addressable and reports it', async () => {
    await skill(join(root, 'weird'), 'name: "../escape"\ndescription: d');
    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['weird']);
    expect(found.problems.find((p) => p.reason === 'unusable-name')).toBeDefined();
  });

  it(`caps the listing at ${MAX_SKILLS} and reports the excess`, async () => {
    for (let i = 0; i < MAX_SKILLS + 3; i += 1) {
      await skill(join(root, `s${String(i).padStart(3, '0')}`), `name: s${String(i).padStart(3, '0')}\ndescription: d`);
    }
    const found = await discoverSkills([root]);
    expect(found.skills).toHaveLength(MAX_SKILLS);
    const problem = found.problems.find((p) => p.reason === 'skill-limit');
    expect(problem?.detail).toContain(String(MAX_SKILLS));
  });
});

describe('the per-skill file manifest', () => {
  it('lists bundled files with sizes, relative to the skill directory', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await mkdir(join(root, 'alpha', 'references'), { recursive: true });
    await writeFile(join(root, 'alpha', 'references', 'notes.md'), 'hello');

    const found = await discoverSkills([root]);
    const files = found.skills[0]?.files ?? [];
    expect(files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'references/notes.md']);
    expect(files.find((f) => f.path === 'references/notes.md')?.size).toBe(5);
  });

  it('does not follow a symlink out of the skill when listing files', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await writeFile(join(root, 'secret.txt'), 'nope');
    await symlink(join(root, 'secret.txt'), join(root, 'alpha', 'link.txt'));

    const found = await discoverSkills([root]);
    const files = found.skills[0]?.files.map((f) => f.path) ?? [];
    expect(files).toEqual(['SKILL.md']);
  });
});

describe('the declaration', () => {
  it('carries the declared scripts through, with the skill marked executable', async () => {
    await skill(
      join(root, 'alpha'),
      'name: alpha\ndescription: a\nmcp-host:\n  version: 1\n  run:\n    - script: scripts/go.js\n      interpreter: node',
    );
    await mkdir(join(root, 'alpha', 'scripts'), { recursive: true });
    await writeFile(join(root, 'alpha', 'scripts', 'go.js'), 'console.log(1)');

    const found = await discoverSkills([root]);
    expect(found.skills[0]?.declaration.run).toHaveLength(1);
  });

  it('reports a declared script that is not in the bundle', async () => {
    await skill(
      join(root, 'alpha'),
      'name: alpha\ndescription: a\nmcp-host:\n  version: 1\n  run:\n    - script: scripts/missing.js\n      interpreter: node',
    );
    const found = await discoverSkills([root]);
    expect(found.problems.find((p) => p.reason === 'declared-script-missing')).toBeDefined();
  });
});
