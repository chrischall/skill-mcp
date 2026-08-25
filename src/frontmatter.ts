/**
 * SKILL.md: the `---` frontmatter block, and the `mcp-host:` declaration
 * inside it (docs/SKILL-MCP.md §7.1).
 *
 * **A declaration NARROWS; it never grants.** The same author wrote the
 * scripts and the block that names them, so nothing here is an authorization —
 * it is the author saying which files are entry points and what each of them
 * wants. What makes a script runnable is the owner accepting it at
 * registration; this adapter enforces the narrowing and intersects it with the
 * owner's grant when one is supplied (see `grant.ts`).
 *
 * The YAML posture is §7.1's: YAML 1.2 core schema, no aliases (a 64 KiB block
 * plus alias expansion is a billion-laughs bomb), an unknown MAJOR refused
 * wholesale, unknown keys ignored and REPORTED BY NAME, and a document that
 * does not parse reported with the parser's position rather than treated as
 * absent. A file whose author believes it is being read and which has never
 * once taken effect is the failure that rule exists for.
 */
import { parseDocument } from 'yaml';
import { checkRelativePath } from './paths.js';

/** Frontmatter that could not be read. Reported per skill; never fatal to a listing. */
export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

/** Largest frontmatter block this reader will parse. */
export const MAX_FRONTMATTER_BYTES = 64 * 1024;

/** The declaration block's major version this adapter understands. */
export const DECLARATION_VERSION = 1;

/** Default and hard-ceiling wall-clock budgets for one `skill_run` (§6). */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;

/**
 * Names the HOST sets, which a skill may never ask to be handed. Mirrors
 * mcp-host's `RESERVED_AUTH_FIELD_NAMES` in spirit: a script asking for
 * `MCP_SKILLS_PATH` is asking to re-point the adapter, and one asking for
 * `MCP_HOST_METER_FILE` is asking for the file the child's meter writes by
 * atomic rename — a second writer OVERWRITES the child's counters rather than
 * adding to them (docs/SKILL-MCP.md §12).
 */
export const RESERVED_SCRIPT_ENV = new Set([
  'MCP_SKILLS_PATH',
  'MCP_SKILL_RUN',
  'SKILLS_DIR',
  'MCP_HOST_METER_FILE',
  'MCP_BLOB_BASE_URL',
  'MCP_BLOB_SIGNING_KEY',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
]);

/** One script a skill declares as an entry point. */
export interface RunDeclaration {
  /** Path relative to the skill's own directory. */
  script: string;
  /** Named by the author, never inferred from an extension or a shebang (§6). */
  interpreter: string;
  /** Variables this script asks to be handed. A request, not a grant. */
  env: string[];
  /** Wall-clock budget, already clamped to {@link MAX_TIMEOUT_MS}. */
  timeoutMs: number;
}

/** A field the skill proposes for the REGISTRATION's own environment (§7.1). */
export interface EnvFieldDeclaration {
  name: string;
  description?: string;
  secret?: boolean;
  required?: boolean;
}

/** Everything this adapter reads out of one SKILL.md's frontmatter. */
export interface SkillDeclaration {
  name?: string;
  description?: string;
  whenToUse?: string;
  run: RunDeclaration[];
  /** Fields proposed for the registration's environment. Never a grant. */
  env: EnvFieldDeclaration[];
  /** Hosts the author says the skill reaches. A proposal for the egress policy. */
  egress: string[];
  /** Everything wrong with the declaration, in words, reported rather than thrown. */
  problems: string[];
}

/** The two halves of a SKILL.md. */
export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n/;

/**
 * Split a SKILL.md into its frontmatter mapping and its body, or throw
 * {@link FrontmatterError}. The body is returned verbatim — `skill_load`
 * resolves nothing inside it (§2.1).
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  if (!FRONTMATTER.test(text)) {
    throw new FrontmatterError('SKILL.md does not begin with a "---" frontmatter block');
  }

  const openEnd = text.indexOf('\n') + 1;
  const closeMatch = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(openEnd));
  if (!closeMatch) {
    throw new FrontmatterError('SKILL.md frontmatter block is never closed by a "---" line');
  }

  const raw = text.slice(openEnd, openEnd + closeMatch.index);
  const body = text.slice(openEnd + closeMatch.index + closeMatch[0].length);

  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_FRONTMATTER_BYTES) {
    throw new FrontmatterError(
      `SKILL.md frontmatter is ${bytes} bytes, over the ${MAX_FRONTMATTER_BYTES}-byte cap`,
    );
  }

  // `&anchor` / `*alias` are refused before the parser can expand them.
  if (/(^|\s)[&*][A-Za-z0-9_-]+/m.test(raw)) {
    throw new FrontmatterError('SKILL.md frontmatter uses a YAML anchor or alias, which is refused');
  }

  // `parseDocument`, not `parse`: the parser recovers from several errors
  // rather than throwing, and a document that "parsed" into a shape its author
  // did not write is exactly the silent misread §7.1 refuses. Errors AND
  // warnings are fatal here — the only warnings this configuration can emit are
  // unresolved tags, i.e. the custom / language-specific tags that are refused.
  let doc;
  try {
    doc = parseDocument(raw, {
      version: '1.2',
      schema: 'core',
      customTags: [],
      logLevel: 'silent',
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new FrontmatterError(`SKILL.md frontmatter is not valid YAML: ${detail}`);
  }

  const complaint = doc.errors[0] ?? doc.warnings[0];
  if (complaint) {
    const where = complaint.linePos?.[0];
    const at = where ? ` (line ${where.line}, column ${where.col})` : '';
    throw new FrontmatterError(
      `SKILL.md frontmatter is not valid YAML: ${complaint.message.split('\n')[0]}${at}`,
    );
  }

  let parsed: unknown;
  try {
    // `maxAliasCount: 0` belongs on the materialisation, not the parse: aliases
    // are expanded here. The pre-parse refusal above is the first of the two.
    parsed = doc.toJS({ maxAliasCount: 0 });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new FrontmatterError(`SKILL.md frontmatter could not be read: ${detail}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterError('SKILL.md frontmatter is not a mapping');
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

/** `undefined` unless the value really is a string (§7.1: `1.10` is a float). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TOP_LEVEL_KNOWN = new Set([
  'name',
  'description',
  'when-to-use',
  'when_to_use',
  'license',
  'version',
  'allowed-tools',
  'metadata',
  'mcp-host',
]);

const BLOCK_KNOWN = new Set(['version', 'run', 'env', 'egress', 'state']);
const RUN_KNOWN = new Set(['script', 'interpreter', 'env', 'timeout']);

/**
 * Read the declaration out of an already-parsed frontmatter mapping.
 *
 * Never throws: a broken `mcp-host:` block costs the skill its scripts, not
 * its instructions. An instructions-only skill is a useful skill.
 */
export function readDeclaration(frontmatter: Record<string, unknown>): SkillDeclaration {
  const problems: string[] = [];
  const decl: SkillDeclaration = {
    name: str(frontmatter.name),
    description: str(frontmatter.description),
    whenToUse: str(frontmatter['when-to-use']) ?? str(frontmatter.when_to_use),
    run: [],
    env: [],
    egress: [],
    problems,
  };

  for (const key of Object.keys(frontmatter)) {
    if (!TOP_LEVEL_KNOWN.has(key)) problems.push(`unknown frontmatter key "${key}" (ignored)`);
  }

  const block = frontmatter['mcp-host'];
  if (block === undefined) return decl;
  if (!isRecord(block)) {
    problems.push('"mcp-host" is not a mapping (ignored)');
    return decl;
  }

  const version = block.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    problems.push('"mcp-host.version" is missing or not an integer — the block is ignored');
    return decl;
  }
  if (version !== DECLARATION_VERSION) {
    problems.push(
      `"mcp-host" declares version ${version}; this adapter understands version ${DECLARATION_VERSION} — the block is ignored`,
    );
    return decl;
  }

  for (const key of Object.keys(block)) {
    if (!BLOCK_KNOWN.has(key)) problems.push(`unknown "mcp-host" key "${key}" (ignored)`);
  }

  decl.run = readRun(block.run, problems);
  decl.env = readEnvFields(block.env, problems);
  decl.egress = readEgress(block.egress, problems);
  return decl;
}

function readRun(value: unknown, problems: string[]): RunDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('"mcp-host.run" is not a list (ignored)');
    return [];
  }

  const out: RunDeclaration[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const at = `"mcp-host.run[${index}]"`;
    if (!isRecord(entry)) {
      problems.push(`${at} is not a mapping (ignored)`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!RUN_KNOWN.has(key)) problems.push(`unknown key "${key}" in ${at} (ignored)`);
    }

    const script = str(entry.script);
    if (script === undefined) {
      problems.push(`${at} has no string "script" (ignored)`);
      return;
    }
    try {
      checkRelativePath(script);
    } catch (err) {
      problems.push(`${at}: ${err instanceof Error ? err.message : String(err)} (ignored)`);
      return;
    }
    if (seen.has(script)) {
      problems.push(`${at} declares "${script}" a second time (ignored)`);
      return;
    }

    const interpreter = str(entry.interpreter);
    if (interpreter === undefined) {
      problems.push(`${at} has no string "interpreter" (ignored)`);
      return;
    }

    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (entry.timeout !== undefined) {
      if (typeof entry.timeout !== 'number' || !(entry.timeout > 0)) {
        problems.push(`${at} has a non-numeric "timeout" — using the ${DEFAULT_TIMEOUT_MS}ms default`);
      } else {
        timeoutMs = Math.round(entry.timeout * 1000);
        if (timeoutMs > MAX_TIMEOUT_MS) {
          problems.push(
            `${at} asks for a ${entry.timeout}s timeout; clamped to the ${MAX_TIMEOUT_MS / 1000}s ceiling`,
          );
          timeoutMs = MAX_TIMEOUT_MS;
        }
      }
    }

    const env: string[] = [];
    if (entry.env !== undefined) {
      if (!Array.isArray(entry.env)) {
        problems.push(`${at} has a non-list "env" (ignored)`);
      } else {
        for (const name of entry.env) {
          const asString = str(name);
          if (asString === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(asString)) {
            problems.push(`${at} asks for an env name that is not an identifier (ignored)`);
            continue;
          }
          if (RESERVED_SCRIPT_ENV.has(asString)) {
            problems.push(`${at} asks for "${asString}", which the host sets — refused`);
            continue;
          }
          if (!env.includes(asString)) env.push(asString);
        }
      }
    }

    seen.add(script);
    out.push({ script, interpreter, env, timeoutMs });
  });

  return out;
}

function readEnvFields(value: unknown, problems: string[]): EnvFieldDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('"mcp-host.env" is not a list (ignored)');
    return [];
  }
  const out: EnvFieldDeclaration[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`"mcp-host.env[${index}]" is not a mapping (ignored)`);
      return;
    }
    const name = str(entry.name);
    if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      problems.push(`"mcp-host.env[${index}]" has no valid "name" (ignored)`);
      return;
    }
    out.push({
      name,
      ...(str(entry.description) !== undefined ? { description: str(entry.description) } : {}),
      ...(typeof entry.secret === 'boolean' ? { secret: entry.secret } : {}),
      ...(typeof entry.required === 'boolean' ? { required: entry.required } : {}),
    });
  });
  return out;
}

function readEgress(value: unknown, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('"mcp-host.egress" is not a list (ignored)');
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const host = str(entry);
    if (host === undefined || !/^[A-Za-z0-9.*-]+$/.test(host)) {
      problems.push('"mcp-host.egress" holds an entry that is not a hostname (ignored)');
      continue;
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}
