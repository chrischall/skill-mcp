/**
 * The four tools. They are the whole contract (docs/SKILL-MCP.md §2.1), and
 * §2.2 says why: mcp-host's `enabledTools` narrowing names TOOLS, so while it
 * is set the prompt and resource surfaces come back empty and the handshake
 * stops advertising those capabilities. Anything reachable only through them
 * would break on a flag that has nothing to do with skills.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpToolError, textResult, toolAnnotations, schemaConfirm } from '@chrischall/mcp-utils';
import type { SkillMcpDeps } from '../deps.js';
import type { DiscoveredSkill } from '../discovery.js';
import { MAX_SKILL_MD_BYTES } from '../discovery.js';
import { MAX_ARGS, interpreterNames, isRunnableInterpreter, runDeclaredScript } from '../run.js';
import { resolveInsideSkill } from '../paths.js';
import { readCapped } from '../read-capped.js';
import { stat } from 'node:fs/promises';

/** Largest file `skill_file` returns (docs/SKILL-MCP.md §2.1). */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Most paths one `skill_file` call may name (docs/SKILL-MCP.md §2.1). */
export const MAX_FILE_PATHS = 8;

/**
 * Most bytes one `skill_file` call may SERVE, across every entry.
 *
 * Without it the per-file cap is defeated by multiplication: eight 1 MiB files
 * base64 to an ~11 MiB frame built in this child's heap, which is exactly what
 * the per-file cap exists to prevent (docs/SKILL-MCP.md §2.1).
 */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;

/** One planned read of a batch: resolved and sized, or refused with a reason. */
interface PlannedRead {
  path: string;
  /** Absent when this entry was refused; its `error` says why. */
  target?: string;
  /** Bytes this entry would contribute to the batch total. Absent when refused. */
  served?: number;
  error?: string;
}

/**
 * What this file would actually COST the batch: its size, capped at what a
 * single entry may return.
 *
 * `min`, because a file over the per-file cap is TRUNCATED to it rather than
 * refused — so its full size is not what the call would serve, and summing it
 * would refuse batches that comfortably fit. `resolveInsideSkill` has already
 * lstat'd this path and refused anything that is not a regular file, so this
 * stat is asking for a number and not for a verdict.
 */
async function servedBytes(target: string): Promise<number> {
  const st = await stat(target);
  return Math.min(st.size, MAX_FILE_BYTES);
}

const NameArg = z
  .string()
  .min(1)
  .describe('The skill\'s name, exactly as skill_list reports it.');

const PathArg = z
  .string()
  .min(1)
  .describe('A path relative to the skill\'s own directory, as skill_load lists it.');

const PathsArg = z
  .array(PathArg)
  .min(1)
  .max(MAX_FILE_PATHS)
  .describe(
    `Up to ${MAX_FILE_PATHS} paths relative to the skill's own directory, as skill_load lists them. ` +
      'Reading a SKILL.md\'s referenced files in one call costs one round trip instead of one each.',
  );

/**
 * Extension → media type, for the handful a skill bundle actually carries.
 *
 * Null-prototype, and read through `Object.hasOwn` below: an ordinary object
 * literal answers `MEDIA_TYPES['constructor']` with a function, which a file
 * named `x.constructor` would put straight into a JSON field of a tool result.
 */
const MEDIA_TYPES: Readonly<Record<string, string>> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
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
  },
);

/** The media type for a bundled file, defaulting to a byte stream. */
export function mediaTypeFor(path: string): string {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : 'application/octet-stream';
}

/**
 * True when these bytes are text. A round-trip check rather than an extension
 * check: an unknown extension is common in a skill bundle and its content is
 * usually text, while a `.md` holding invalid UTF-8 must not be mangled into
 * replacement characters.
 *
 * Exported because the resource projection reads the SAME bytes through a
 * second door (`prompts.ts`) and the two doors must not disagree about what
 * they are: a NUL-byte test there called invalid UTF-8 "text" and served it
 * mangled, while this one answered base64 for the identical file.
 */
export function isUtf8Text(bytes: Buffer): boolean {
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
        grantFrom: config.grantFrom,
        // "Nothing runs here" has more than one cause, and a caller cannot act
        // on it without being told which. The hosted default is the one that
        // looks like a broken server and is not (config.ts).
        ...(config.grantFrom === 'hosted-default'
          ? {
              grantNote:
                'The roots were injected by a host and no MCP_SKILL_RUN grant was supplied, so nothing may run. A script becomes runnable when the registration grants it; the instructions and files of every skill are served either way.',
            }
          : {}),
        ...(config.grantError !== undefined
          ? {
              grantError: `${config.grantError} — nothing is granted, so no script may run until it is fixed.`,
            }
          : {}),
        skills: catalog.skills.map((skill) => {
          const granted = new Set(skill.scripts.map((entry) => entry.script));
          // Both of the reported lists below are read off the DECLARATION,
          // which is information and never authority: what may actually run is
          // `scripts` and nothing else. Shown rather than omitted so "this
          // skill has scripts and none of them run here" is legible instead of
          // looking like a skill that declared nothing.
          const unavailableScripts = skill.declaration.run
            .filter((entry) => !isRunnableInterpreter(entry.interpreter))
            .map((entry) => ({
              script: entry.script,
              reason: `declares the interpreter "${entry.interpreter}"; this deployment runs: ${interpreterNames().join(', ')}`,
            }));
          const ungrantedScripts = skill.declaration.run
            .filter((entry) => isRunnableInterpreter(entry.interpreter) && !granted.has(entry.script))
            .map((entry) => ({
              script: entry.script,
              reason:
                'declared by the skill and not granted for this registration, so it may not run here',
            }));

          return {
            name: skill.name,
            ...(skill.description !== undefined ? { description: skill.description } : {}),
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            source: skill.root,
            files: skill.files.length,
            bytes: skill.files.reduce((sum, file) => sum + file.size, 0),
            executable: skill.scripts.some((entry) => isRunnableInterpreter(entry.interpreter)),
            // The EXACT list, never "this skill has scripts": a client told a
            // skill is executable and left to guess the entry point will guess.
            scripts: skill.scripts
              .filter((entry) => isRunnableInterpreter(entry.interpreter))
              .map((entry) => ({
                script: entry.script,
                interpreter: entry.interpreter,
                timeoutMs: entry.timeoutMs,
                env: entry.env,
              })),
            unavailableScripts,
            ...(ungrantedScripts.length > 0 ? { ungrantedScripts } : {}),
            ...(skill.declaration.egress.length > 0
              ? { declaredEgress: skill.declaration.egress }
              : {}),
          };
        }),
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
          runnableHere: isRunnableInterpreter(entry.interpreter),
        })),
      });
    },
  );

  server.registerTool(
    'skill_file',
    {
      description:
        "Read files a skill bundles. Paths are relative to that skill's own directory; text comes back as text, anything else as base64 with its media type. Ask for every file you need in ONE call — a SKILL.md usually points at several.",
      annotations: toolAnnotations({ title: 'Read skill files', readOnly: true, idempotent: true }),
      inputSchema: { name: NameArg, paths: PathsArg },
    },
    async ({ name, paths }) => {
      const skill = requireSkill(deps, name);

      // PASS 1 — resolve and size every path before reading a byte of any of
      // them, because the batch total is decided from what would be SERVED
      // (docs/SKILL-MCP.md §2.1). Deciding it while accumulating would make the
      // answer depend on the order the caller happened to list the paths in.
      //
      // A path that cannot be resolved is that ENTRY's error and not the
      // batch's: a client reading the four files a SKILL.md names, one of which
      // the author has since renamed, still gets the other three.
      const planned = await Promise.all(
        paths.map(async (path): Promise<PlannedRead> => {
          try {
            // Both halves of the containment check live in resolveInsideSkill:
            // a read is not less dangerous than an execution here. It runs per
            // path — batching changes how many arrive, never what one may name.
            const target = await resolveInsideSkill(skill.dir, path);
            return { path, target, served: await servedBytes(target) };
          } catch (err) {
            return { path, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );

      const planning = planned.reduce((total, entry) => total + (entry.served ?? 0), 0);
      if (planning > MAX_BATCH_BYTES) {
        // The one bound with no per-entry slot to report it in: the call as a
        // whole blew the budget and no single entry is the reason.
        throw new McpToolError(
          `those ${paths.length} paths would return ${planning} bytes, over this call's ${MAX_BATCH_BYTES}-byte limit`,
          {
            hint: 'Ask for fewer files in one call, or read the largest on its own. skill_load lists every file with its size.',
          },
        );
      }

      // PASS 2 — read. BOUNDED, not read-whole-then-slice: the cap exists to
      // keep a bundled file out of this child's heap, and a hosted child has
      // RLIMIT_DATA 256 MiB hard while §5.3 permits a 256 MiB bundle — so a
      // slice after the fact bounds the frame and kills the server.
      const files = await Promise.all(
        planned.map(async (entry) => {
          if (entry.target === undefined) return { path: entry.path, error: entry.error };
          try {
            const { bytes, size, truncated } = await readCapped(entry.target, MAX_FILE_BYTES);
            const text = isUtf8Text(bytes);
            return {
              path: entry.path,
              size,
              mediaType: mediaTypeFor(entry.path),
              encoding: text ? 'utf-8' : 'base64',
              // Reported rather than cut silently, per ENTRY, so a batch says
              // WHICH of its reads was cut.
              truncated,
              ...(truncated
                ? {
                    truncationNote: `The file is ${size} bytes; the first ${MAX_FILE_BYTES} are returned.`,
                  }
                : {}),
              content: text ? bytes.toString('utf8') : bytes.toString('base64'),
            };
          } catch (err) {
            return { path: entry.path, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );

      // IN REQUEST ORDER (docs/SKILL-MCP.md §2.1): Promise.all preserves it, so
      // a caller pairs entry N with the path it asked for at N rather than
      // matching on the string.
      return textResult({ skill: skill.name, files });
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
    // The two refusals are different facts and the caller can act on only one
    // of them: "the skill never declared this" is a typo or a wrong pin, while
    // "declared and not granted" is a registration edit the owner makes.
    const inDeclaration = skill.declaration.run.some((entry) => entry.script === script);
    throw new McpToolError(
      inDeclaration
        ? `"${script}" is declared by the skill "${skill.name}" but is not granted for this registration, so it may not run`
        : `"${script}" is not declared as a runnable script by the skill "${skill.name}"`,
      {
        hint:
          offered.length > 0
            ? `This registration may run: ${offered.join(', ')}. Only a script named in SKILL.md's "mcp-host.run" block, and accepted for this registration, may run.`
            : 'Nothing may run for this skill. A script becomes runnable by being named in SKILL.md\'s "mcp-host.run" block AND accepted at registration; skill_list reports which of the two is missing.',
      },
    );
  }

  if (!isRunnableInterpreter(declared.interpreter)) {
    throw new McpToolError(
      `"${script}" declares the interpreter "${declared.interpreter}", which this deployment cannot run; it runs: ${interpreterNames().join(', ')}`,
      { hint: "The skill's instructions are still available through skill_load." },
    );
  }

  // Resolves and re-checks containment, so a declared script that is a symlink
  // out of the tree is refused at the preview too.
  await resolveInsideSkill(skill.dir, script);

  // `typeof === 'string'`, matching buildScriptEnv exactly: `!== undefined` is
  // true for a name inherited from Object.prototype, and the preview must name
  // the variables the script will actually be handed and no others.
  const env = declared.env.filter((name) => typeof deps.sourceEnv[name] === 'string');
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
            envNotSet: declared.env.filter((name) => typeof deps.sourceEnv[name] !== 'string'),
          }
        : {}),
    },
    note: 'No process has been started. Re-run with confirm: true to execute. This server cannot tell what a script does — it only decides which script runs and what it is handed.',
  };
}
