/**
 * The containment fence, tested at the two layers it is built from.
 *
 * A read is not less dangerous than an execution here (docs/SKILL-MCP.md §2.1):
 * the skills slot sits beside the install tree and the child's own `$HOME`, so
 * `../../` out of a skill directory is another registration's bundle at best.
 * Every rule below therefore covers `skill_file` and `skill_run` alike.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathRefusedError, checkRelativePath, resolveInsideSkill } from '../src/paths.js';

let root = '';
let skillDir = '';
let outsideFile = '';

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'skill-paths-')));
  skillDir = join(root, 'bundle', 'demo');
  await mkdir(join(skillDir, 'scripts'), { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nbody\n');
  await writeFile(join(skillDir, 'scripts', 'ok.js'), 'console.log(1)\n');

  outsideFile = join(root, 'outside.txt');
  await writeFile(outsideFile, 'secrets\n');

  // A symlink that leaves the skill directory, pointing at an absolute path.
  await symlink(outsideFile, join(skillDir, 'escape-abs.txt'));
  // A symlink that leaves it by relative traversal.
  await symlink('../../outside.txt', join(skillDir, 'escape-rel.txt'));
  // A symlink that stays inside — legitimate, must keep working.
  await symlink('scripts/ok.js', join(skillDir, 'inside-link.js'));
  // A directory symlink out of the tree, so a path THROUGH it is also refused.
  await symlink(root, join(skillDir, 'up'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('checkRelativePath — the STRING check, before any join', () => {
  for (const bad of [
    '/etc/passwd',
    '../outside.txt',
    'scripts/../../outside.txt',
    './ok.js',
    'scripts//ok.js',
    '',
    'scripts\\ok.js',
    'C:\\windows\\system32',
    '%2e%2e/outside.txt',
    'scripts/ok.js\0.png',
    '  ',
    'scripts/',
  ]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => checkRelativePath(bad)).toThrow(PathRefusedError);
    });
  }

  it('accepts a plain relative path', () => {
    expect(checkRelativePath('scripts/ok.js')).toBe('scripts/ok.js');
  });

  it('says WHY it refused, and hints at the shape it does accept', () => {
    try {
      checkRelativePath('../outside.txt');
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PathRefusedError);
      expect((err as Error).message).toContain('".." segment');
      expect((err as PathRefusedError).hint).toMatch(/relative to the skill/i);
    }
  });
});

describe('resolveInsideSkill — the RESOLVED check, after symlinks are followed', () => {
  it('resolves an ordinary file', async () => {
    await expect(resolveInsideSkill(skillDir, 'scripts/ok.js')).resolves.toBe(
      join(skillDir, 'scripts', 'ok.js'),
    );
  });

  it('allows a symlink that stays inside the skill directory', async () => {
    await expect(resolveInsideSkill(skillDir, 'inside-link.js')).resolves.toBe(
      join(skillDir, 'scripts', 'ok.js'),
    );
  });

  it('refuses a symlink whose ABSOLUTE target leaves the skill directory', async () => {
    await expect(resolveInsideSkill(skillDir, 'escape-abs.txt')).rejects.toThrow(PathRefusedError);
  });

  it('refuses a symlink whose RELATIVE target leaves the skill directory', async () => {
    await expect(resolveInsideSkill(skillDir, 'escape-rel.txt')).rejects.toThrow(PathRefusedError);
  });

  it('refuses a path that traverses THROUGH a directory symlink pointing out', async () => {
    await expect(resolveInsideSkill(skillDir, 'up/outside.txt')).rejects.toThrow(PathRefusedError);
  });

  it('refuses a directory where a regular file is required', async () => {
    await expect(resolveInsideSkill(skillDir, 'scripts')).rejects.toThrow(PathRefusedError);
  });

  it('refuses a path that does not exist', async () => {
    await expect(resolveInsideSkill(skillDir, 'nope.js')).rejects.toThrow(PathRefusedError);
  });

  it('string-refuses before it ever touches the filesystem', async () => {
    await expect(resolveInsideSkill(skillDir, '../outside.txt')).rejects.toThrow(PathRefusedError);
  });
});
