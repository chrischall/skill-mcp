/**
 * Discovery has to be robust in a specific way: one bad skill directory may
 * never cost the listing. A directory with no SKILL.md is SKIPPED with a
 * reason, malformed frontmatter is reported per skill, and a name collision is
 * reported rather than silently shadowing (docs/SKILL-MCP.md §2.1's uniqueness
 * rule, enforced here as a report because the adapter is downstream of the
 * resolve that should have refused it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, open, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, MAX_SKILLS, MAX_SKILL_MD_BYTES } from '../src/discovery.js';
import { checkRelativePath } from '../src/paths.js';

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

  /*
   * The manifest and the read tools have to agree about what is addressable.
   * `checkRelativePath` is a conservative SHAPE rule (§6 wants the string check
   * before any join), so it refuses characters that are legal in a POSIX
   * filename. Listing such a file would advertise a path that `skill_file` and
   * `resources/read` then refuse — an inconsistency the caller cannot act on.
   */
  it('every path it lists survives the path check the read tools apply', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await mkdir(join(root, 'alpha', 'refs'), { recursive: true });
    await writeFile(join(root, 'alpha', 'refs', 'ok.md'), 'fine');
    await writeFile(join(root, 'alpha', 'read%20me.txt'), 'percent');
    await writeFile(join(root, 'alpha', 'back\\slash.txt'), 'backslash');

    const found = await discoverSkills([root]);
    for (const file of found.skills[0]?.files ?? []) {
      expect(() => checkRelativePath(file.path)).not.toThrow();
    }
  });

  it('skips a file whose name the read tools would refuse, and says which', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await writeFile(join(root, 'alpha', 'read%20me.txt'), 'percent');

    const found = await discoverSkills([root]);
    expect(found.skills[0]?.files.map((f) => f.path)).toEqual(['SKILL.md']);
    const problem = found.problems.find((p) => p.reason === 'unusable-path');
    expect(problem?.detail).toContain('read%20me.txt');
  });

  it('skips a whole subtree under an unusable directory name, once', async () => {
    await skill(join(root, 'alpha'), 'name: alpha\ndescription: a');
    await mkdir(join(root, 'alpha', 'od%d'), { recursive: true });
    await writeFile(join(root, 'alpha', 'od%d', 'a.txt'), 'a');
    await writeFile(join(root, 'alpha', 'od%d', 'b.txt'), 'b');

    const found = await discoverSkills([root]);
    expect(found.skills[0]?.files.map((f) => f.path)).toEqual(['SKILL.md']);
    expect(found.problems.filter((p) => p.reason === 'unusable-path')).toHaveLength(1);
  });
});

/**
 * Containment at DISCOVERY, which is a different rule from containment at read
 * or at execution: `resolveInsideSkill` takes the skill's own directory as its
 * root, so a skill directory that already escaped the configured root is
 * "contained" in the wrong place and reaches execution unrefused. Every entry
 * point into the tree therefore has to be re-checked against the root's own
 * real path (docs/SKILL-MCP.md §2.1).
 */
describe('containment at discovery', () => {
  it('does not serve skills through a `skills` directory that is a symlink out of the root', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'skill-elsewhere-')));
    try {
      await skill(join(elsewhere, 'evil'), 'name: evil\ndescription: out of tree');
      await symlink(elsewhere, join(root, 'skills'));

      const found = await discoverSkills([root]);
      expect(found.skills).toEqual([]);
      const problem = found.problems.find((p) => p.reason === 'symlink-escape');
      expect(problem).toBeDefined();
      expect(problem?.detail).toMatch(/outside/i);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('does not serve a skill directory that is reached by a symlink out of the root', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'skill-elsewhere-b-')));
    try {
      await skill(join(elsewhere, 'evil'), 'name: evil\ndescription: out of tree');
      await mkdir(join(root, 'skills'), { recursive: true });
      await symlink(join(elsewhere, 'evil'), join(root, 'skills', 'evil'));

      const found = await discoverSkills([root]);
      expect(found.skills).toEqual([]);
      // REPORTED, not merely refused. The module's own rule is that a directory
      // which is not served is skipped WITH A REASON, and `skill_list` promises
      // an empty list is never a mystery — a `readdir` dirent is `lstat`-based,
      // so a symlinked entry is not a directory and used to fall out of the
      // scan without ever reaching the containment check below it.
      const problem = found.problems.find((p) => p.reason === 'symlink-escape');
      expect(problem?.path).toBe(join(root, 'skills', 'evil'));
      expect(problem?.detail).toMatch(/outside/i);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('reports an escaping symlinked skill directory at the root level too', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'skill-elsewhere-d-')));
    try {
      await skill(join(elsewhere, 'evil'), 'name: evil\ndescription: out of tree');
      await symlink(join(elsewhere, 'evil'), join(root, 'evil'));

      const found = await discoverSkills([root]);
      expect(found.skills).toEqual([]);
      expect(found.problems.find((p) => p.reason === 'symlink-escape')?.path).toBe(
        join(root, 'evil'),
      );
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('tells a BROKEN symlink apart from an escaping one', async () => {
    // Both are refused; only one of them is a security event, and the owner
    // has a different fix for each.
    await mkdir(join(root, 'skills'), { recursive: true });
    await symlink(join(root, 'skills', 'gone'), join(root, 'skills', 'dangling'));

    const found = await discoverSkills([root]);
    const problem = found.problems.find((p) => p.reason === 'symlink-escape');
    expect(problem?.path).toBe(join(root, 'skills', 'dangling'));
    expect(problem?.detail).toMatch(/broken symlink/i);
  });

  it('SERVES a skill directory symlinked from elsewhere INSIDE the root', async () => {
    // `skills/foo -> ../shared/foo` is an ordinary way to assemble a bundle, so
    // this is the same two-outcome rule as the refusal above rather than a
    // third, silent one.
    await skill(join(root, 'shared', 'gamma'), 'name: gamma\ndescription: shared');
    await mkdir(join(root, 'skills'), { recursive: true });
    await symlink(join(root, 'shared', 'gamma'), join(root, 'skills', 'gamma'));

    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['gamma']);
    expect(found.problems.find((p) => p.reason === 'symlink-escape')).toBeUndefined();
  });

  it('refuses a SKILL.md that is a symlink out of its own skill directory', async () => {
    await writeFile(join(root, 'SECRET.md'), '---\nname: pwned\ndescription: not this skill\n---\ntop secret\n');
    await mkdir(join(root, 'victim'), { recursive: true });
    await symlink(join(root, 'SECRET.md'), join(root, 'victim', 'SKILL.md'));

    const found = await discoverSkills([root]);
    expect(found.skills).toEqual([]);
    const problem = found.problems.find((p) => p.reason === 'symlink-escape');
    expect(problem?.detail).toMatch(/SKILL\.md/);
  });

  it('refuses a root whose own SKILL.md is a symlink out of the root', async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'skill-elsewhere-c-')));
    try {
      await writeFile(join(elsewhere, 'SECRET.md'), '---\nname: pwned\ndescription: d\n---\ntop secret\n');
      await symlink(join(elsewhere, 'SECRET.md'), join(root, 'SKILL.md'));

      const found = await discoverSkills([root]);
      expect(found.skills).toEqual([]);
      expect(found.problems.find((p) => p.reason === 'symlink-escape')).toBeDefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('still serves a SKILL.md symlinked from INSIDE the same skill directory', async () => {
    // The rule is containment, not "no symlinks".
    await mkdir(join(root, 'inner'), { recursive: true });
    await writeFile(join(root, 'inner', 'real.md'), '---\nname: inner\ndescription: d\n---\nbody\n');
    await symlink(join(root, 'inner', 'real.md'), join(root, 'inner', 'SKILL.md'));

    const found = await discoverSkills([root]);
    expect(found.skills.map((s) => s.name)).toEqual(['inner']);
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

/*
 * A hostile SKILL.md is a REPORTED problem, never an unbootable server — the
 * deferred-config-error pattern this module is built around. A whole-file read
 * of a huge SKILL.md breaks that at the worst possible moment: discovery runs
 * at BOOT, so the failure is not a bad tool call but a child that cannot start,
 * and it repeats on every respawn. mcp-host gives a hosted child RLIMIT_DATA
 * 256 MiB hard (CLAUDE.md, `rlimits.ts`) while §5.3 permits a 256 MiB bundle.
 */
describe('a huge SKILL.md', () => {
  it('is read up to the cap, reported as truncated, and allocates no more', async () => {
    const dir = join(root, 'bulky');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    await writeFile(path, '---\nname: bulky\ndescription: enormous\n---\nbody\n');
    // Sparse: extends the file with zeroes at no cost, and leaves the
    // frontmatter parseable so this exercises the READ, not the parser.
    const handle = await open(path, 'r+');
    try {
      await handle.truncate(256 * 1024 * 1024);
    } finally {
      await handle.close();
    }

    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    };
    const timer = setInterval(sample, 2);
    let found;
    try {
      found = await discoverSkills([root]);
    } finally {
      clearInterval(timer);
    }
    sample();

    expect(found.skills.map((s) => s.name)).toEqual(['bulky']);
    expect(found.skills[0]?.bodyTruncated).toBe(true);
    expect(found.skills[0]?.body.length).toBeLessThanOrEqual(MAX_SKILL_MD_BYTES);
    expect(peak - before).toBeLessThan(32 * 1024 * 1024);
  });
});
