/**
 * Finding the skills under the roots this server was pointed at.
 *
 * Three rules shape everything here, and each is a failure it prevents:
 *
 *  - **A directory with no SKILL.md is SKIPPED WITH A REASON.** Silence here
 *    reads as "the server is broken" to whoever pointed it at the wrong
 *    subdirectory; a reason makes it a one-line fix.
 *  - **A malformed skill costs itself, never the listing.** Frontmatter is
 *    third-party YAML; one file that does not parse must not take the other
 *    nineteen down with it.
 *  - **A name collision is REPORTED, never shadowed.** Two directories
 *    contributing one name is refused at the resolve upstream
 *    (docs/SKILL-MCP.md §2.1); an adapter that silently picked one would make
 *    the choice by scan order, which is the thing that refusal exists to
 *    prevent. Here the first wins deterministically AND the collision is named.
 *
 * Nothing in this module reads a file's contents except SKILL.md, and nothing
 * follows a symlink out of a skill directory OR out of the configured root.
 * That second half is a separate rule from the containment `paths.ts` applies,
 * and it has to live HERE: `resolveInsideSkill` takes the skill's own directory
 * as its containment root, so a skill directory that already escaped the root
 * is contained in the wrong place and every later check happily agrees with it.
 * Three entry points into the tree are therefore re-checked against the root's
 * real path — a root's own `SKILL.md`, the `skills/` subdirectory, and every
 * candidate directory — and a skill's `SKILL.md` is `lstat`ed before it is
 * read, so a link out of the skill directory cannot serve another file's bytes
 * as this skill's instructions. The manifest walk stays `lstat`-based and skips
 * every link it finds.
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, posix, basename } from 'node:path';
import { isInside, relativePathProblem } from './paths.js';
import { readCapped } from './read-capped.js';
import {
  FrontmatterError,
  parseSkillMd,
  readDeclaration,
  type RunDeclaration,
  type SkillDeclaration,
} from './frontmatter.js';

/**
 * The number of skills one registration may serve — mcp-host's
 * `MAX_SKILLS_PER_REGISTRATION` (docs/SKILL-MCP.md §5.3), mirrored here so a
 * bundle that grew past it is bounded rather than unbounded. Reported, never
 * silently truncated.
 */
export const MAX_SKILLS = 32;

/** Bounds the manifest walk of one skill directory. */
export const MAX_FILES_PER_SKILL = 2_000;

/** Largest SKILL.md this adapter reads (docs/SKILL-MCP.md §2.1). */
export const MAX_SKILL_MD_BYTES = 256 * 1024;

/** One file inside a skill's bundle. */
export interface SkillFile {
  /** POSIX-separated, relative to the skill's own directory. */
  path: string;
  size: number;
}

/** A skill this server serves. */
export interface DiscoveredSkill {
  /** Unique across everything this server serves; the address every tool takes. */
  name: string;
  description?: string;
  whenToUse?: string;
  /** Absolute path of the skill's own directory — the containment root. */
  dir: string;
  /** The root it was found under, for `skill_list`'s `source`. */
  root: string;
  /** SKILL.md's body, verbatim. */
  body: string;
  /** True when the body was cut at {@link MAX_SKILL_MD_BYTES}. */
  bodyTruncated: boolean;
  files: SkillFile[];
  /**
   * The scripts that may actually run: the declaration intersected with the
   * owner's grant when the host supplied one (`grant.ts`). Discovery sets it to
   * the declaration; `applyGrant` is the only thing that narrows it, and
   * nothing widens it.
   */
  scripts: RunDeclaration[];
  declaration: SkillDeclaration;
}

/** Why one directory is not (fully) being served. */
export interface DiscoveryProblem {
  path: string;
  reason:
    | 'root-unreadable'
    | 'no-skill-md'
    | 'unreadable-skill-md'
    | 'malformed-frontmatter'
    | 'declaration'
    | 'duplicate-name'
    | 'name-mismatch'
    | 'unusable-name'
    | 'declared-script-missing'
    /** A symlink led out of the configured root, or out of a skill directory. */
    | 'symlink-escape'
    /** A filename the read tools would refuse, so the manifest does not list it. */
    | 'unusable-path'
    | 'file-limit'
    | 'skill-limit'
    /** The registration granted a script the skill does not declare (`grant.ts`). */
    | 'grant';
  detail: string;
}

/** Everything one scan produced. */
export interface Catalog {
  roots: string[];
  skills: DiscoveredSkill[];
  problems: DiscoveryProblem[];
}

/** A skill name has to be addressable: it is the key every tool takes. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk a skill directory into a file manifest.
 *
 * `lstat`-based and link-skipping on purpose: a symlink inside a bundle may
 * point anywhere, and listing (or sizing) its target would report another
 * skill's file — or the child's own `$HOME` — as this skill's content.
 * `skill_file` applies the containment check separately, so a link that stays
 * inside the tree is still readable by its real path.
 *
 * It also applies the read tools' own SHAPE rule (`relativePathProblem`), and
 * skipping there is REPORTED rather than silent: the manifest is what a client
 * reads paths out of, so listing one `skill_file` and `resources/read` would
 * then refuse advertises an address that does not work. A directory whose name
 * fails the rule takes its whole subtree with it, once.
 */
async function walkFiles(
  dir: string,
  problems: DiscoveryProblem[],
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const queue: string[] = [''];
  let capped = false;

  while (queue.length > 0) {
    const rel = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) continue;
      const unusable = relativePathProblem(childRel);
      if (unusable !== undefined) {
        problems.push({
          path: dir,
          reason: 'unusable-path',
          detail: `"${childRel}" cannot be addressed by skill_file (${unusable}), so it is not listed${entry.isDirectory() ? ' — nor is anything under it' : ''}`,
        });
        continue;
      }
      if (entry.isDirectory()) {
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES_PER_SKILL) {
        capped = true;
        continue;
      }
      const st = await lstat(join(dir, childRel)).catch(() => null);
      if (!st) continue;
      files.push({ path: childRel, size: st.size });
    }
  }

  if (capped) {
    problems.push({
      path: dir,
      reason: 'file-limit',
      detail: `more than ${MAX_FILES_PER_SKILL} files; the manifest lists the first ${MAX_FILES_PER_SKILL}`,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Read one candidate directory into a skill, or into a problem. */
async function readSkill(
  dir: string,
  root: string,
  problems: DiscoveryProblem[],
): Promise<DiscoveredSkill | null> {
  const skillMd = join(dir, 'SKILL.md');

  // `readFile` follows symlinks, so this check has to happen before it: a
  // `SKILL.md -> ../../SECRET.md` would otherwise be served verbatim as this
  // skill's instructions AND as its MCP prompt, with the out-of-tree
  // frontmatter renaming the skill on the way past. `dir` is already a real
  // path (the caller resolved it), so the comparison is sound.
  const link = await lstat(skillMd).catch(() => null);
  if (!link) {
    problems.push({
      path: dir,
      reason: 'unreadable-skill-md',
      detail: 'SKILL.md could not be stat\'d',
    });
    return null;
  }
  if (link.isSymbolicLink()) {
    // Containment, not "no symlinks": a link that stays inside the skill is
    // fine, and refusing those would break ordinary bundle layouts.
    const target = await realpath(skillMd).catch(() => null);
    if (target === null || !isInside(dir, target)) {
      problems.push({
        path: dir,
        reason: 'symlink-escape',
        detail: `SKILL.md is a symlink pointing outside this skill's own directory (${target ?? 'unresolvable'}); refused`,
      });
      return null;
    }
  } else if (!link.isFile()) {
    problems.push({
      path: dir,
      reason: 'unreadable-skill-md',
      detail: 'SKILL.md is not a regular file',
    });
    return null;
  }

  let text: string;
  let truncated = false;
  try {
    // A BOUNDED read, not a whole-file read that is sliced afterwards. This
    // runs at BOOT, so an unbounded one turns a hostile SKILL.md into a child
    // that cannot start — the exact opposite of the deferred-config-error
    // pattern this module exists to hold up (read-capped.ts).
    const read = await readCapped(skillMd, MAX_SKILL_MD_BYTES);
    truncated = read.truncated;
    text = read.bytes.toString('utf8');
  } catch (err) {
    problems.push({
      path: dir,
      reason: 'unreadable-skill-md',
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let parsed;
  try {
    parsed = parseSkillMd(text);
  } catch (err) {
    problems.push({
      path: dir,
      reason: err instanceof FrontmatterError ? 'malformed-frontmatter' : 'unreadable-skill-md',
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const declaration = readDeclaration(parsed.frontmatter);
  for (const detail of declaration.problems) {
    problems.push({ path: dir, reason: 'declaration', detail });
  }

  const dirName = basename(dir);
  let name = declaration.name ?? dirName;
  if (!NAME.test(name)) {
    problems.push({
      path: dir,
      reason: 'unusable-name',
      detail: `frontmatter "name" is not addressable; serving this skill as "${dirName}" instead`,
    });
    name = dirName;
  } else if (declaration.name !== undefined && declaration.name !== dirName) {
    problems.push({
      path: dir,
      reason: 'name-mismatch',
      detail: `frontmatter names it "${declaration.name}" but the directory is "${dirName}"; serving it as "${declaration.name}"`,
    });
  }
  if (!NAME.test(name)) {
    problems.push({
      path: dir,
      reason: 'unusable-name',
      detail: `neither the frontmatter nor the directory gives an addressable name; skipped`,
    });
    return null;
  }

  const files = await walkFiles(dir, problems);
  const present = new Set(files.map((f) => f.path));
  for (const entry of declaration.run) {
    if (!present.has(entry.script)) {
      problems.push({
        path: dir,
        reason: 'declared-script-missing',
        detail: `declares "${entry.script}", which is not a file in this skill`,
      });
    }
  }

  return {
    name,
    ...(declaration.description !== undefined ? { description: declaration.description } : {}),
    ...(declaration.whenToUse !== undefined ? { whenToUse: declaration.whenToUse } : {}),
    dir,
    root,
    body: parsed.body,
    bodyTruncated: truncated,
    files,
    scripts: declaration.run,
    declaration,
  };
}

/**
 * The real path of `path`, but only if it is still inside `root`. `null`
 * otherwise, which every caller treats as "do not go there".
 */
async function realInside(root: string, path: string): Promise<string | null> {
  const real = await realpath(path).catch(() => null);
  if (real === null || !isInside(root, real)) return null;
  return real;
}

/**
 * Candidate skill directories under one root, in a stable order.
 *
 * `root` is already a real path. Every directory returned is a real path
 * inside it: the `skills/` subdirectory is resolved and checked BEFORE it is
 * scanned (so an escaping one is refused rather than merely reported per
 * candidate), and each candidate is resolved and checked again.
 *
 * A symlinked entry gets TWO outcomes, never a silent third. `readdir`'s
 * dirents are `lstat`-based, so `skills/foo -> …` is not a directory here and
 * used to fall out of the scan reported as nothing at all — which is wrong both
 * ways round: `skills/foo -> ../shared/foo` is an ordinary way to assemble a
 * bundle and its owner saw an empty connector, while `skills/foo -> /outside`
 * was refused with no reason given. So a link is resolved, served when
 * `realInside` holds and reported as `symlink-escape` when it does not.
 */
async function candidates(
  root: string,
  problems: DiscoveryProblem[],
): Promise<{ dirs: string[]; nonSkill: string[] }> {
  const dirs: string[] = [];
  const nonSkill: string[] = [];

  if (await isFile(join(root, 'SKILL.md'))) return { dirs: [root], nonSkill };

  const scan = async (parent: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const link = entry.isSymbolicLink();
      if (!entry.isDirectory() && !link) continue;

      const dir = join(parent, entry.name);
      // `<root>/skills` is resolved and reported by the dedicated block below;
      // reporting it here too would name one escape twice.
      const deferred = parent === root && entry.name === 'skills';

      // Resolved in two steps rather than through `realInside`, so a BROKEN
      // link is not reported as an escape: both are refused, and telling their
      // owner which one they have is the whole point of reporting at all.
      const real = await realpath(dir).catch(() => null);
      if (real === null || !isInside(root, real)) {
        if (!deferred) {
          problems.push({
            path: dir,
            reason: 'symlink-escape',
            detail:
              real === null
                ? 'this entry could not be resolved — a broken symlink, or one whose target is unreadable; refused'
                : link
                  ? 'this entry is a symlink resolving outside the configured root; refused'
                  : 'this directory resolves outside the configured root; refused',
          });
        }
        continue;
      }
      // A link may point at a file; that is not a candidate skill directory and
      // never was — plain files are skipped here without comment.
      if (link && !(await isDirectory(real))) continue;

      if (await isFile(join(real, 'SKILL.md'))) dirs.push(real);
      else if (deferred) continue;
      else nonSkill.push(real);
    }
  };

  await scan(root);

  const skillsDir = join(root, 'skills');
  if (await isDirectory(skillsDir)) {
    const real = await realInside(root, skillsDir);
    if (real === null) {
      problems.push({
        path: skillsDir,
        reason: 'symlink-escape',
        detail: 'the "skills" directory resolves outside the configured root; refused',
      });
    } else {
      await scan(real);
    }
  }

  return { dirs, nonSkill };
}

/**
 * Scan every root and return the catalog. Never throws for a bad root, a bad
 * skill or a bad declaration — everything that went wrong comes back in
 * `problems`, which `skill_list` returns to the caller.
 */
export async function discoverSkills(roots: string[]): Promise<Catalog> {
  const problems: DiscoveryProblem[] = [];
  const skills: DiscoveredSkill[] = [];
  const byName = new Map<string, DiscoveredSkill>();
  let overflow = 0;

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
      if (!(await isDirectory(realRoot))) throw new Error('not a directory');
    } catch (err) {
      problems.push({
        path: root,
        reason: 'root-unreadable',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const { dirs, nonSkill } = await candidates(realRoot, problems);
    for (const dir of nonSkill) {
      problems.push({
        path: dir,
        reason: 'no-skill-md',
        detail: 'no SKILL.md in this directory, so it is not a skill',
      });
    }

    for (const dir of dirs) {
      const skill = await readSkill(dir, root, problems);
      if (!skill) continue;

      const existing = byName.get(skill.name);
      if (existing) {
        problems.push({
          path: dir,
          reason: 'duplicate-name',
          detail: `two directories both contribute the skill "${skill.name}" (${existing.dir} and ${dir}); serving the first and ignoring the second`,
        });
        continue;
      }
      if (skills.length >= MAX_SKILLS) {
        overflow += 1;
        continue;
      }
      byName.set(skill.name, skill);
      skills.push(skill);
    }
  }

  if (overflow > 0) {
    problems.push({
      path: roots.join(':'),
      reason: 'skill-limit',
      detail: `found ${skills.length + overflow} skills; serving the first ${MAX_SKILLS} and ignoring ${overflow}`,
    });
  }

  return { roots, skills, problems };
}
