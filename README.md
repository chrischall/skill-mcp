# skill-mcp

An MCP server that serves a directory of **Agent Skills**. Point it at skills;
it lists them, hands out their instructions and their bundled files, and runs
**only the scripts a skill declares**.

It is a generic adapter, not a curated set: the skills are content it reads, and
the same build serves whatever it is pointed at.

```bash
npx @chrischall/skill-mcp                       # serves the example skill bundled here
SKILLS_DIR=~/my-skills npx @chrischall/skill-mcp
```

The npm package is **`@chrischall/skill-mcp`** (unscoped `skill-mcp` is taken by
someone else on npm). Everything else — the repo, the binary, the registry
identity `io.github.chrischall/skill-mcp` — is unscoped.

## What a skill is

A directory holding `SKILL.md`: YAML frontmatter (`name`, `description`, and
optionally the `mcp-host:` block below) followed by instructions, plus whatever
files those instructions refer to. Three layouts are found under each root:

```
<root>/SKILL.md              # the root IS one skill
<root>/<name>/SKILL.md       # a directory of skills
<root>/skills/<name>/SKILL.md
```

## The tools

| tool | arguments | returns |
| --- | --- | --- |
| `skill_list` | — | every skill found: name, description, when to use it, file count, whether it declares runnable scripts and **exactly which**; plus `problems`, so an empty list is never a mystery |
| `skill_load` | `name` | the SKILL.md body **verbatim**, plus a manifest of the bundle's files. Referenced files are not inlined — that is what `skill_file` is for |
| `skill_file` | `name`, `path` | one file from that skill's directory: text, or base64 with its media type. At most 1 MiB, `truncated: true` rather than a silent cut |
| `skill_run` | `name`, `script`, `args[]`, `confirm` | `{exitCode, stdout, stderr, truncated, durationMs}` |

`skill_file` takes **one** path. The design of record specifies a `paths[]`
batch (8 paths per call, 1 MiB per entry, 4 MiB per call, one bad path failing
only its own slot); shipping the singular form is a deliberate deferral, not an
oversight, and those three bounds are what a later batching change has to
honour. Read the caps as bounds on this server's own heap: they cap the
**allocation**, not only the answer, because a hosted child has a hard 256 MiB
data limit and a bundle may be larger than that.

Each skill is **also** registered as an MCP prompt (its body is the message) and
each bundled file as a resource (`skill://<name>/<path>`), because a client that
supports those surfaces presents a skill better than a tool call does. It is a
second door, never the only one: when this server runs on
[mcp-host](https://github.com/chrischall/mcp-host) and a registration narrows
`enabledTools`, `prompts/list` and `resources/list` come back empty and the
handshake stops advertising those capabilities — so **the tools carry the whole
experience**.

## Discovery reports, it never goes quiet

Anything that keeps a directory from being served comes back in `skill_list`'s
`problems`, with the path and the reason: no `SKILL.md`, frontmatter that will
not parse, a name two directories both claim, a declared script that is not in
the bundle, a symlink leading out of the root or out of a skill, a filename the
read tools could not address. One bad skill costs itself and never the listing,
and there is no third outcome where something is dropped in silence — a
symlinked skill directory is **served** when it stays inside the root (so
`skills/foo -> ../shared/foo` works) and **reported** when it does not.

## The execution fence

`skill_run` executes third-party code. Every rule below narrows **which** code
runs and **what it is handed**; each has its own test.

- **Only a script the skill DECLARES.** Not "any file under `scripts/`", not
  "anything executable". An undeclared path is refused, saying it must be
  declared and listing the ones that are.
- **Only inside that skill's own directory.** The path is checked as a string
  first (plain segments; no leading `/`, no `.` or `..`, no backslash, no
  percent escape, no NUL) and then again after resolution: the **real** path,
  with symlinks followed, must still be inside the skill's real directory, and
  it must be a regular file. Both checks, because a string check alone misses a
  symlink planted inside the bundle and a resolved check alone accepts shapes
  that should never have been joined. The same discipline governs `skill_file`:
  a read out of a skill directory is another skill's bundle at best.
- **An argv array, never a shell string.** `spawn` with `shell: false`, no
  interpolation, no `sh -c`. Arguments are passed through verbatim.
- **An interpreter from a closed set**, named by the declaration — never
  inferred from the extension and never taken from the file's own shebang, since
  a file that can choose its own interpreter has already chosen its own program.
  **v1 runs `node` and nothing else** (see *What v1 cannot run*).
- **Bounded, and the call always returns.** A wall-clock timeout (60 s default,
  per-script override, hard 300 s ceiling), 1 MiB captured per stream with
  `truncated: true` rather than a silent cut, and one `skill_run` at a time. On
  timeout the process **group** is signalled, which reaches the script and any
  child that stayed in its group. It does **not** reach a grandchild that
  detached into a group of its own, and such a grandchild also holds the stdio
  pipes open — so the run settles on the process exiting plus a short drain,
  under a hard deadline, rather than on the pipes closing. That is what
  guarantees the tool call returns within its budget and frees the
  one-at-a-time lock; it is not a guarantee that a deliberately detached
  grandchild is dead. Bounding *that* is the tier's job (an unprivileged uid,
  `prlimit` NPROC, and a machine that stops), not this adapter's.
- **An env allowlist.** A script gets `PATH`, `HOME`, `LANG`, `TZ`, `TMPDIR`,
  `MCP_DATA_DIR` when the host set one, and **exactly the variables that script
  asked for and the owner granted** — never this server's own environment. The
  fixed half mirrors mcp-host's `INSTALL_ALLOWLIST`
  (`packages/runner-node/src/spawn-env.ts`), for the reason that file gives: a
  host constant a hosted declaration cannot widen by one name.
- **A non-zero exit is a normal, reported outcome** — exit code, stdout and
  stderr all come back. It is never an exception that loses the output.
- **`skill_run` is confirm-gated.** Without `confirm: true` it starts no process
  and returns a dry-run preview of exactly what would run: the interpreter, the
  argv, the working directory, the timeout, and the **names** of the variables
  the script would be handed.

### Why the confirm gate is blanket

The fleet convention gates mutating tools. Whether a given script mutates
anything is something this server cannot know: it never reads a script, and it
deliberately does not analyse one — a machine-generated verdict about somebody
else's code gets trusted in a way an author's declaration does not. Unknown
effects are therefore treated as mutating.

The obvious softening — let a skill mark a script read-only and skip the gate
for it — is refused because it is circular: the same author wrote the script and
the sentence describing it, so a self-declared "read-only" authorizes nothing.
That leaves a blanket gate. Its cost is one extra round-trip on a read-only
helper; its benefit is that the preview is the one place a caller sees the exact
call before any of it happens.

### What the fence does NOT buy

**A declared script is still arbitrary code.** These rules narrow which code
runs and with what; none of them makes the code safe. A script you allow can
read the whole skills tree, spend the machine's CPU, and send whatever it holds
anywhere its network permits. `skill_run`'s output caps are truncation, not
confidentiality: nothing redacts a script's stdout, and nothing could.

**This is not a sandbox.** Run it against skills you have read, or run it
somewhere that fences it — under mcp-host that means the isolated tier
(`fly-machine`): a microVM per registration, an unprivileged uid, `prlimit`
bounds, and nftables default-deny with a declared egress allowlist. This server
is a narrowing on top of such a fence, not a replacement for one.

## What v1 cannot run

The set of interpreters is `node`, one entry, and that is a measured decision
rather than an oversight: mcp-host's runner image is Node + git + tar +
util-linux + nftables, with no `python3`, `curl` or `jq`, while real skills are
overwhelmingly Python (70 `.py` against 1 `.js` in `anthropics/skills` at
`3b3fad96`).

So a skill declaring a Python script is reported by `skill_list` under
`unavailableScripts`, with the interpreter and this deployment's set named, and
`skill_run` refuses it in the same words. **Its instructions still serve** —
an instructions-only skill is a useful skill, and most published skills are
exactly that. A pinned interpreter is a follow-up that arrives as a dependency,
never as an image change.

## The `mcp-host:` declaration block

Optional, inside SKILL.md's frontmatter:

```yaml
---
name: weather
description: Forecasts and geocoding.
mcp-host:
  version: 1
  run:
    - script: scripts/forecast.js
      interpreter: node
      env: [WEATHER_API_KEY]     # variables this SCRIPT asks for
      timeout: 30                # seconds; clamped to 300
  env:                           # fields proposed for the SERVER's environment
    - name: WEATHER_API_KEY
      secret: true
  egress: [api.weather.example]  # hosts this skill reaches; a proposal
---
```

**A declaration narrows; it never grants.** The author of the scripts also wrote
the block naming them, so nothing in it is an authorization — it says which
files are entry points and what each wants. What makes a script runnable, and a
variable reach it, is somebody else accepting it.

Read strictly: YAML 1.2 core schema, anchors and aliases refused, a 64 KiB cap,
an unknown MAJOR version refused wholesale, unknown keys ignored **and reported
by name**, and a block that does not parse reported with the parser's position
rather than treated as absent. A broken block costs a skill its scripts, never
its instructions, and never the rest of the listing.

## Configuration

| variable | meaning |
| --- | --- |
| `MCP_SKILLS_PATH` | `:`-separated slot roots, injected by mcp-host's runner. Wins over everything |
| `SKILLS_DIR` | the same thing for local use. Read only when `MCP_SKILLS_PATH` is unset |
| `MCP_SKILL_RUN` | optional JSON `[{skill, script, env?}]` — the owner's grant. **Narrow-only** |
| *(neither set)* | this package's own `skills/` directory |

`MCP_SKILL_RUN` deserves the emphasis. When it is present, what may run is the
declaration **intersected** with it — a row naming a script the skill did not
declare grants nothing (and is reported), and a row naming a variable the script
did not ask for grants nothing. There is no spelling of it that makes something
runnable which a skill did not declare, which is what makes it safe to read from
an environment that also carries a registration's own variables.

**When it is absent, the default depends on who supplied the roots, and the
hosted half is fail-closed.**

- **Roots from `MCP_SKILLS_PATH`** (a host is injecting them, so there is a
  registration and an owner behind this child): **nothing is granted and nothing
  runs.** Every skill's instructions and files are still served — that is a
  working, useful connector. The reason is that one child holds one environment
  holding every credential the owner set, so a skill whose frontmatter named its
  *neighbour's* variable would otherwise be handed the neighbour's credential
  with nobody having decided to give it.
- **Roots from `SKILLS_DIR`, or the packaged default**: the skill's own
  declaration stands. Nothing is injecting anything, and the person who pointed
  the server at a directory is the owner.

`skill_list` reports which case it is (`grantFrom`, plus a `grantNote` in the
hosted one) and lists a skill's declared-but-ungranted scripts, so "nothing
runs" is never indistinguishable from "nothing was declared".

## Trust posture

- **This server's code is the operator's**; the skills are yours. It reads a
  fixed set of directories handed to it, fetches nothing, installs nothing, and
  has no tool that takes a path outside a skill's own directory.
- **It vets nothing.** There is no badge, no publisher allowlist, no scan. A
  skill's instructions and its scripts are exactly as trustworthy as whoever
  wrote them.
- **A read is treated as dangerously as an execution**, because the directory it
  reads from sits beside everything else on the machine.
- **It caches nothing and stores nothing.** The catalog is scanned once at boot
  and held in memory; no file is written anywhere.

## Hosting on mcp-host

`mint.yaml` at the repo root says how this MCP wants to be registered. Four
things it deliberately does **not** propose, because only a registration can
decide them:

- **The runtime — and it *could not*, by rule.** A manifest may never name one
  (docs/MINT-MANIFEST.md §5): which tier a registration lands on is decided by
  who is asking, not by the package, since a file that could ask for
  `fly-shared` would be a stranger's package requesting a seat on the operator's
  own machine. A hosted skill server belongs on the **isolated** tier
  (`fly-machine`) with a declared egress policy, and that is the registration's
  choice to make.

- **The skills themselves.** They arrive as a pinned dependency (a
  `github-archive` naming a repository and an exact commit) and land in a
  read-only slot the runner names through `MCP_SKILLS_PATH`. This package cannot
  know which ones a given registration carries.
- **`state.dataDir`.** The adapter needs no persistence. Turn it on when a
  registration's skills have scripts that need somewhere to write — the slot is
  read-only, so `MCP_DATA_DIR` (with it on) or `TMPDIR` (without) is where a
  script's output goes — and give the reason there.
- **The real egress allowlist.** `mint.yaml` proposes `allow: []`, which is what
  the adapter itself needs: it reaches nothing. The hosts a registration needs
  are the ones its SKILLS declare, shown at the preview with who declared them
  and accepted by the owner. On the isolated tier a host that is not on the list
  appears either as an HTTP 403 from the loopback proxy or as a plain timeout —
  the two are indistinguishable from inside a script, so `skill_run` attaches a
  note saying so whenever a call fails on a machine that looks fenced.

Narrowing `enabledTools` to `[skill_list, skill_load, skill_file]` is the
non-executable switch, enforced at the gateway rather than here — a stronger
statement than this server refusing `skill_run`, and it costs the prompt and
resource surfaces entirely.

## Development

```bash
npm install
npm run build      # tsc → dist/, esbuild → dist/bundle.js
npm test           # vitest
```

---

This project was developed and is maintained by AI. Use at your own discretion.
