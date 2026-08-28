# CLAUDE.md — skill-mcp

Guidance for Claude working in this repo. Fleet-wide conventions (the
auto-review ladder, the merge policy, release-please rules) live in
`~/.claude/CLAUDE.md` and `chrischall/workflows` — deliberately NOT restated
here. What follows is true of this repo and nowhere else.

## TL;DR

An MCP server that serves a **directory of Agent Skills**: it lists them, hands
out their instructions and bundled files, and runs only the scripts a skill
declares AND the owner granted. A generic adapter — the skills are content it
reads, and the same build serves whatever it is pointed at.

Two ways it runs, and they have OPPOSITE defaults (below): standalone at your
own terminal, or hosted on mcp-host as a registration.

```bash
npm test          # typecheck (tsc -p tsconfig.tests.json) THEN vitest
npm run build     # tsc + esbuild bundle -> dist/
```

`npm test` typechecks first on purpose: vitest transpiles with esbuild and
never runs `tsc`, so a type error in a test file passes every suite and then
fails CI.

## The tool surface

Four tools, and they are the whole contract (`src/tools/skills.ts`).

| tool | takes | returns |
| --- | --- | --- |
| `skill_list` | — | every skill: name, description, source, file count, which scripts may run |
| `skill_load` | `name` | SKILL.md verbatim + a manifest of bundled files. Referenced files are NOT inlined |
| `skill_file` | `name`, `paths[]` | one entry per path, in request order: text, or base64 + media type, or that path's own error |
| `skill_run` | `name`, `script`, `args[]`, `confirm` | `{exitCode, stdout, stderr, truncated, durationMs}` |

Skills are also projected as MCP **prompts** and **resources**
(`skill://<name>/<path>`, `src/prompts.ts`). That projection is a second door,
never the only one — everything reachable there is reachable through the tools.

## Load-bearing invariants (tested — don't weaken)

- **A skill is named by its DIRECTORY, never by its frontmatter**
  (`src/discovery.ts`). A `name:` that disagrees is reported as
  `name-mismatch` and otherwise ignored, and a directory whose own name is not
  addressable is skipped rather than renamed by its content. This is not
  tidiness: the owner's grant is keyed by skill name, so a bundle that could
  choose its name could claim its neighbour's name and be handed the
  neighbour's script AND the neighbour's environment. A real duplicate refuses
  BOTH sides and names every contributing directory.
- **The grant can only ever NARROW** (`src/grant.ts`). `MCP_SKILL_RUN` is a
  JSON array of `{skill, script, env?}`; a row naming a script the skill did
  not declare grants nothing, and a row naming a variable the script did not
  ask for grants nothing. The widest this adapter is ever is the declaration
  itself. Keyed on `basename(skill.dir)` — the second line under the rule
  above — and the map key is NUL-separated, written as the `\0` ESCAPE.
  **Never a literal NUL byte in source**: it makes git treat the file as
  binary, which is how this module once shipped as `Bin 5859 -> 6511 bytes`
  with no reviewable diff.
- **An absent grant means opposite things in the two modes** (`src/config.ts`).
  Hosted, it is the EMPTY grant — there is a registration behind that child and
  §7 of mcp-host's design says empty by default. Standalone there is no
  registration and no owner but the person at the terminal, so the declaration
  stands. "Hosted" is detected from any runner-INJECTED marker
  (`MCP_SKILLS_PATH`, `MCP_HOST_METER_FILE`, `MCP_DATA_DIR`,
  `MCP_BLOB_BASE_URL`), not from `SKILLS_DIR` alone — a registration's plain
  `env` can carry `SKILLS_DIR`, and keying on it put the hosted case on the
  fail-OPEN default. That heuristic may only ever move the default closed.
- **Every path is checked twice, on the STRING and on the resolved real path**
  (`src/paths.ts`). No leading `/`, no `.`/`..` segment, no backslash, no
  percent escape, no NUL; then `realpath` and a containment check against the
  skill's own realpath'd directory; then `lstat`, which must report a regular
  file. A read is not less dangerous than an execution here — the slot sits
  beside other skills and the child's `$HOME`.
- **Reads are BOUNDED, never read-whole-then-slice** (`src/read-capped.ts`).
  A hosted child gets RLIMIT_DATA 256 MiB and a bundle may be far larger, so
  `readFile` followed by a slice bounds the frame and kills the server. `stat`
  for the real size, then read at most `maxBytes + 1` — the one extra byte is
  what decides `truncated` without a second syscall.
- **Caps are stated, not discovered.** `MAX_SKILLS` 32,
  `MAX_FILES_PER_SKILL` 2000, `MAX_SKILL_MD_BYTES` 256 KiB,
  `MAX_FRONTMATTER_BYTES` 64 KiB, `MAX_FILE_BYTES` 1 MiB,
  `MAX_FILE_PATHS` 8 and `MAX_BATCH_BYTES` 4 MiB for one `skill_file` call,
  `MAX_STREAM_BYTES` 1 MiB and `MAX_TIMEOUT_MS` 300 s for a run,
  `MAX_RESOURCES` 500. A batch's total is decided from `stat` BEFORE a byte is
  read, summing `min(size, MAX_FILE_BYTES)` — the bytes that would actually be
  served — so the answer cannot depend on the order the caller listed paths in.
- **A truncation is REPORTED, never silent** — per entry for `skill_file`, so a
  batch says which of its reads was cut.

## Gotchas

- ESM + NodeNext: `.js` extensions on relative imports in `.ts`.
- `skill_run` is declared `destructiveHint: true` / `idempotentHint: false`
  because what a script does is unknown BY CONSTRUCTION — this adapter never
  reads a script and deliberately does not analyse one. Unknown is declared as
  destructive rather than optimistically as neither.
- The bundled `skills/skill-mcp-demo` is a fixture AND the default corpus when
  no `SKILLS_DIR` is set, so changing it changes what a bare `npx` run serves.
- `package.json` `files` must keep `skills/` — without it the demo skill does
  not ship and a bare run has nothing to serve.

## Related

The hosting design this adapter was built against is `docs/SKILL-MCP.md` in
`chrischall/mcp-host` — including why a skill's pin, its egress and its
execution fence live there rather than here.
