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
 * containment check the tools use: a URI is caller input like any other path.
 */
import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillMcpDeps } from './deps.js';
import { resolveInsideSkill } from './paths.js';
import { mediaTypeFor, MAX_FILE_BYTES } from './tools/skills.js';

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
          // Re-resolved on every read rather than trusted from the listing: the
          // URI arrives from the caller, and a listed path is not a capability.
          const target = await resolveInsideSkill(skill.dir, file.path);
          const raw = await readFile(target);
          const bytes = raw.byteLength > MAX_FILE_BYTES ? raw.subarray(0, MAX_FILE_BYTES) : raw;
          const mimeType = mediaTypeFor(file.path);
          const isText = !bytes.includes(0);
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
