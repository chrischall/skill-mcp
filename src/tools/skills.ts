/**
 * The four tools. They are the whole contract (docs/SKILL-MCP.md §2.1), and
 * §2.2 says why: mcp-host's `enabledTools` narrowing names TOOLS, so while it
 * is set the prompt and resource surfaces come back empty and the handshake
 * stops advertising those capabilities. Anything reachable only through them
 * would break on a flag that has nothing to do with skills.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { SkillMcpDeps } from '../deps.js';
import type { DiscoveredSkill } from '../discovery.js';
import { MAX_SKILL_MD_BYTES } from '../discovery.js';
import { INTERPRETERS, MAX_ARGS, runDeclaredScript } from '../run.js';
import { resolveInsideSkill } from '../paths.js';

/** Largest file `skill_file` returns (docs/SKILL-MCP.md §2.1). */
export const MAX_FILE_BYTES = 1024 * 1024;

const NameArg = z
  .string()
  .min(1)
  .describe('The skill\'s name, exactly as skill_list reports it.');

const PathArg = z
  .string()
  .min(1)
  .describe('A path relative to the skill\'s own directory, as skill_load lists it.');

/** Extension → media type, for the handful a skill bundle actually carries. */
const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  html: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  xsd: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** The media type for a bundled file, defaulting to a byte stream. */
export function mediaTypeFor(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return MEDIA_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * True when these bytes are text. A round-trip check rather than an extension
 * check: an unknown extension is common in a skill bundle and its content is
 * usually text, while a `.md` holding invalid UTF-8 must not be mangled into
 * replacement characters.
 */
function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes);
}

function requireSkill(deps: SkillMcpDeps, name: string): DiscoveredSkill {
  const skill = deps.skill(name);
  if (skill) return skill;
  const known = deps.catalog.skills.map((s) => s.name);
  throw new McpToolError(`no skill named "${name}"`, {
    hint:
      known.length > 0
        ? `This server serves: ${known.join(', ')}.`
        : 'This server found no skills at all — call skill_list, whose "problems" say why.',
  });
}

/** Register `skill_list`, `skill_load`, `skill_file` and `skill_run`. */
export function registerSkillTools(server: McpServer, deps: SkillMcpDeps): void {
  server.registerTool(
    'skill_list',
    {
      description:
        'List every Agent Skill this server found: name, description, when to use it, how many files it bundles, and the exact scripts (if any) that may be executed with skill_run. Also reports anything that could not be read, so an empty list is never a mystery.',
      annotations: toolAnnotations({ title: 'List skills', readOnly: true, idempotent: true }),
      inputSchema: {},
    },
    () => {
      const { catalog, config } = deps;
      return textResult({
        roots: catalog.roots,
        rootsFrom: config.rootsFrom,
        ...(config.grantError !== undefined
          ? {
              grantError: `${config.grantError} — nothing is granted, so no script may run until it is fixed.`,
            }
          : {}),
        skills: catalog.skills.map((skill) => ({
          name: skill.name,
          ...(skill.description !== undefined ? { description: skill.description } : {}),
          ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
          source: skill.root,
          files: skill.files.length,
          bytes: skill.files.reduce((sum, file) => sum + file.size, 0),
          executable: skill.scripts.some((entry) => INTERPRETERS[entry.interpreter] !== undefined),
          // The EXACT list, never "this skill has scripts": a client told a
          // skill is executable and left to guess the entry point will guess.
          scripts: skill.scripts
            .filter((entry) => INTERPRETERS[entry.interpreter] !== undefined)
            .map((entry) => ({
              script: entry.script,
              interpreter: entry.interpreter,
              timeoutMs: entry.timeoutMs,
              env: entry.env,
            })),
          // Shown as refusals rather than omitted, so "this skill has scripts
          // and none of them run here" is legible instead of looking like a
          // skill that declared nothing.
          unavailableScripts: skill.scripts
            .filter((entry) => INTERPRETERS[entry.interpreter] === undefined)
            .map((entry) => ({
              script: entry.script,
              reason: `declares the interpreter "${entry.interpreter}"; this deployment runs: ${Object.keys(INTERPRETERS).join(', ')}`,
            })),
          ...(skill.declaration.egress.length > 0
            ? { declaredEgress: skill.declaration.egress }
            : {}),
        })),
        problems: catalog.problems,
      });
    },
  );

  server.registerTool(
    'skill_load',
    {
      description:
        "Load one skill's SKILL.md instructions verbatim, plus a manifest of the files it bundles. Referenced files are NOT inlined — read them by name with skill_file.",
      annotations: toolAnnotations({ title: 'Load a skill', readOnly: true, idempotent: true }),
      inputSchema: { name: NameArg },
    },
    ({ name }) => {
      const skill = requireSkill(deps, name);
      return textResult({
        name: skill.name,
        ...(skill.description !== undefined ? { description: skill.description } : {}),
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
        source: skill.root,
        body: skill.body,
        // Reported rather than cut silently — the rule the run path uses for
        // its output, applied to the read path for the same reason.
        truncated: skill.bodyTruncated,
        ...(skill.bodyTruncated
          ? { truncationNote: `SKILL.md was cut at ${MAX_SKILL_MD_BYTES} bytes.` }
          : {}),
        files: skill.files,
        scripts: skill.scripts.map((entry) => ({
          script: entry.script,
          interpreter: entry.interpreter,
          runnableHere: INTERPRETERS[entry.interpreter] !== undefined,
        })),
      });
    },
  );

  server.registerTool(
    'skill_file',
    {
      description:
        "Read one file a skill bundles. The path is relative to that skill's own directory; text comes back as text, anything else as base64 with its media type.",
      annotations: toolAnnotations({ title: 'Read a skill file', readOnly: true, idempotent: true }),
      inputSchema: { name: NameArg, path: PathArg },
    },
    async ({ name, path }) => {
      const skill = requireSkill(deps, name);
      // Both halves of the containment check live in resolveInsideSkill: a read
      // is not less dangerous than an execution here.
      const target = await resolveInsideSkill(skill.dir, path);

      const raw = await readFile(target);
      const truncated = raw.byteLength > MAX_FILE_BYTES;
      const bytes = truncated ? raw.subarray(0, MAX_FILE_BYTES) : raw;
      const text = isUtf8Text(bytes);

      return textResult({
        skill: skill.name,
        path,
        size: raw.byteLength,
        mediaType: mediaTypeFor(path),
        encoding: text ? 'utf-8' : 'base64',
        truncated,
        ...(truncated
          ? { truncationNote: `The file is ${raw.byteLength} bytes; the first ${MAX_FILE_BYTES} are returned.` }
          : {}),
        content: text ? bytes.toString('utf8') : bytes.toString('base64'),
      });
    },
  );

  server.registerTool(
    'skill_run',
    {
      description:
        "Execute a script the skill DECLARES as runnable, with an argument array. Returns the exit code and the captured output; a non-zero exit is a normal, reported outcome. Mutating: call it once without confirm to see exactly what would run, then again with confirm: true.",
      annotations: {
        title: 'Run a declared skill script',
        readOnlyHint: false,
        // What the script does is unknown to this adapter BY CONSTRUCTION — it
        // never reads a script and deliberately does not analyse one
        // (docs/SKILL-MCP.md §9 refuses that as a guess wearing the authority
        // of an analysis). Unknown is therefore declared as destructive and
        // non-idempotent rather than optimistically as neither.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        name: NameArg,
        script: z
          .string()
          .min(1)
          .describe('The exact script path skill_list reports for this skill.'),
        args: z
          .array(z.string())
          .max(MAX_ARGS)
          .optional()
          .describe('Arguments passed as an argv array. There is no shell: nothing here is interpreted.'),
        confirm: schemaConfirm,
      },
    },
    async ({ name, script, args, confirm }) => {
      const skill = requireSkill(deps, name);
      const argv = args ?? [];

      /*
       * The confirm gate, and why it is blanket rather than per-script.
       *
       * The fleet convention is that every mutating tool takes `confirm` and,
       * without it, makes no call and returns a dry-run preview. The question
       * here is whether a script counts as mutating, and the honest answer is
       * that this adapter cannot know: it never reads a script, and §9
       * deliberately refuses to analyse one, because a machine-generated
       * verdict about somebody else's code is trusted in a way an author's
       * declaration is not. Unknown effects are therefore treated as mutating.
       *
       * The tempting middle path — let the skill mark a script read-only and
       * skip the gate for it — is refused for §7's opening reason: the same
       * author wrote the script and the block that describes it, so a
       * self-declared "read-only" is circular as an authorization. That leaves
       * a blanket gate, whose cost is one extra round-trip on a read-only
       * helper and whose benefit is that the preview is the ONE surface where
       * a caller sees the exact argv, interpreter, cwd, timeout and the NAMES
       * of the variables the script will be handed before any of it happens.
       */
      const preview = await previewRun(deps, skill, script, argv);
      if (confirm !== true) return textResult(preview);

      const result = await runDeclaredScript({
        skill,
        script,
        args: argv,
        lock: deps.lock,
        sourceEnv: deps.sourceEnv,
      });
      return textResult(result);
    },
  );
}

/**
 * Everything `skill_run` checks before it starts a process, rendered as the
 * dry-run body. Run for the preview AND for the real call, so a call that would
 * be refused is refused at the preview rather than accepted and refused later.
 */
async function previewRun(
  deps: SkillMcpDeps,
  skill: DiscoveredSkill,
  script: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const declared = skill.scripts.find((entry) => entry.script === script);
  if (!declared) {
    const offered = skill.scripts.map((entry) => entry.script);
    throw new McpToolError(
      `"${script}" is not declared as a runnable script by the skill "${skill.name}"`,
      {
        hint:
          offered.length > 0
            ? `This skill declares: ${offered.join(', ')}. Only a script named in SKILL.md's "mcp-host.run" block, and accepted for this registration, may run.`
            : 'This skill declares no runnable scripts. A script becomes runnable by being named in SKILL.md\'s "mcp-host.run" block and accepted at registration.',
      },
    );
  }

  if (INTERPRETERS[declared.interpreter] === undefined) {
    throw new McpToolError(
      `"${script}" declares the interpreter "${declared.interpreter}", which this deployment cannot run; it runs: ${Object.keys(INTERPRETERS).join(', ')}`,
      { hint: "The skill's instructions are still available through skill_load." },
    );
  }

  // Resolves and re-checks containment, so a declared script that is a symlink
  // out of the tree is refused at the preview too.
  await resolveInsideSkill(skill.dir, script);

  const env = declared.env.filter((name) => deps.sourceEnv[name] !== undefined);
  return {
    dryRun: true,
    willRun: {
      skill: skill.name,
      interpreter: declared.interpreter,
      argv: [script, ...args],
      cwd: skill.dir,
      timeoutMs: declared.timeoutMs,
      // NAMES only, never values: this body is a tool result.
      envNames: env,
      ...(declared.env.length > env.length
        ? {
            envNotSet: declared.env.filter((name) => deps.sourceEnv[name] === undefined),
          }
        : {}),
    },
    note: 'No process has been started. Re-run with confirm: true to execute. This server cannot tell what a script does — it only decides which script runs and what it is handed.',
  };
}
