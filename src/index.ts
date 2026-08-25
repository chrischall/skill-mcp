#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { VERSION } from './version.js';
import { createDeps } from './deps.js';
import { registerSkillTools } from './tools/skills.js';
import { registerSkillPrompts } from './prompts.js';

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
