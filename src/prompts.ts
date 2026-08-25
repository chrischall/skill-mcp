/**
 * The same skills, projected as MCP prompts and resources.
 *
 * Clients that support those surfaces present a skill far better than a tool
 * call does: a prompt appears in a slash-command menu, a resource in an
 * attachment picker. **It is a second door, never the only one**
 * (docs/SKILL-MCP.md §2.2). mcp-host's `enabledTools` narrowing names TOOLS,
 * and a tool name cannot name a prompt or a resource, so while it is set
 * `prompts/list` and `resources/list` come back empty, `prompts/get` and
 * `resources/read` are refused, and the handshake stops advertising those
 * capabilities at all. An adapter that put anything only behind them would
 * break on a flag that has nothing to do with skills — so this module registers
 * nothing that `skill_load` and `skill_file` do not already serve.
 *
 * Resources are registered from the catalog snapshot and read through the same
 * containment check — and the same text/binary decision — the tools use, so the
 * second door cannot answer differently about the same bytes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillMcpDeps } from './deps.js';
import { resolveInsideSkill } from './paths.js';
import { readCapped } from './read-capped.js';
import { isUtf8Text, mediaTypeFor, MAX_FILE_BYTES } from './tools/skills.js';

/**
 * Total resources this server registers. A bundle of several thousand files
 * would otherwise put its whole tree into every `resources/list`; the files
 * beyond the cap stay reachable through `skill_file`, which is the point of the
 * projection being a second door.
 */
export const MAX_RESOURCES = 500;

/** Register one prompt per skill and one resource per bundled file. */
export function registerSkillPrompts(server: McpServer, deps: SkillMcpDeps): void {
  let registered = 0;

  for (const skill of deps.catalog.skills) {
    const description = [skill.description, skill.whenToUse].filter(Boolean).join(' ');

    server.registerPrompt(
      skill.name,
      {
        title: skill.name,
        description: description === '' ? `The ${skill.name} skill.` : description,
      },
      () => ({
        messages: [
          {
            role: 'user' as const,
            // The body VERBATIM, exactly as skill_load serves it.
            content: { type: 'text' as const, text: skill.body },
          },
        ],
      }),
    );

    for (const file of skill.files) {
      if (registered >= MAX_RESOURCES) break;
      registered += 1;
      const uri = `skill://${skill.name}/${file.path}`;
      server.registerResource(
        uri,
        uri,
        { title: `${skill.name}: ${file.path}`, mimeType: mediaTypeFor(file.path) },
        async () => {
          // The SDK routes by exact registered URI, so `file.path` here is the
          // catalog's own value rather than caller input. It still goes through
          // the containment resolve, because a path that was inside the skill
          // when the catalog was built is not the same claim as one that is
          // inside it now — a symlink can be planted between the two — and
          // because one resolver for both doors is what keeps them agreeing.
          const target = await resolveInsideSkill(skill.dir, file.path);
          // The same bounded read `skill_file` uses, for the same reason: this
          // door is narrower, not safer (read-capped.ts).
          const { bytes } = await readCapped(target, MAX_FILE_BYTES);
          const mimeType = mediaTypeFor(file.path);
          // The SAME text/binary decision `skill_file` makes, from the same
          // function: one file must not come back mangled as text through one
          // door and base64 through the other.
          const isText = isUtf8Text(bytes);
          return {
            contents: [
              isText
                ? { uri, mimeType, text: bytes.toString('utf8') }
                : { uri, mimeType, blob: bytes.toString('base64') },
            ],
          };
        },
      );
    }
  }
}
