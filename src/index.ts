#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { createDeps } from './deps.js';
import { registerSkillTools } from './tools/skills.js';
import { registerSkillPrompts } from './prompts.js';
import { scrubExecEnvironment } from './scrub-environ.js';

// FIRST, before any script can exist: wipe the exec-time environment block so
// a script cannot read every credential this registration holds out of
// /proc/<ppid>/environ (src/scrub-environ.ts, chrischall/fleet-audit#244).
// process.env keeps every value. Stderr only — stdout is the MCP channel.
const scrub = scrubExecEnvironment();
if (scrub.status === 'failed') {
  process.stderr.write(
    `[skill-mcp] could not wipe the exec-time environment block (${scrub.reason}); a script can read this server's full environment from /proc/<ppid>/environ\n`,
  );
}

// The deps are built in the CALLER so the deferred-config-error pattern holds:
// scanning the roots never throws, an unreadable root or an unreadable grant
// becomes a reported problem rather than a boot failure, and the server answers
// a host's install-time tools/list probe even when it was pointed at nothing.
const deps = await createDeps();

await runMcp({
  name: 'skill-mcp',
  version: VERSION,
  banner:
    '[skill-mcp] This project was developed and is maintained by AI. Skills are third-party content: a declared script is arbitrary code, and this server narrows which code runs — it is not a sandbox. Use at your own discretion.',
  deps,
  tools: [registerSkillTools, registerSkillPrompts],
});
