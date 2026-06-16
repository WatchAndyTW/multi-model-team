# multi-model-team

A Claude Code plugin that lets Claude delegate token-heavy, self-contained tasks
to local pre-authed CLI backends — **`agy`** (Gemini) and **`codex`** (OpenAI Codex CLI) —
choosing the backend/model dynamically by task size and type, with credit-exhaustion fallback
through the backend chain to native Claude, and a glanceable statusline HUD. `/team` fans a task out
across parallel agents — **agy, codex and native Claude are equal, configurable tools**: the
decomposer assigns each subtask to its best-fit backend and any backend can be the verifier (defaults:
codex verifies) — with per-backend caps and an Ultracode dynamic-workflow path.

The core idea: **offload commodity work** (new UI/components, scaffolding, CRUD, scripts,
SQL, configs, unit tests, web-research/doc-summarization, bulk ingestion) to a local CLI
backend, while **keeping judgment-heavy and systems-hard work** (RE, IL2CPP/protobuf-RE,
disassembly, FFI/unsafe, injection, concurrency, protocol design) on Claude. Every routing
decision is driven by config you can tune without touching code.

**Stack:** Node ESM (`.mjs`), zero-build, Node >=18. **One native runtime dependency: `node-pty`**
(gives the agy/Gemini lane a real pseudo-terminal — ConPTY on Windows, forkpty on POSIX — so it works
headlessly); everything else is Node stdlib. Cross-platform (Windows/Linux/macOS). `package.json`
`"type":"module"`.

---

## Status

Built and verified against **agy v1.0.8** and **codex-cli 0.139.0** on Windows.
`npm test` (`node --test "test/*.test.mjs"`) passes **81/81** offline, plus live agy + codex
smoke tests under `MMT_LIVE=1`. Active backends: **agy** (Gemini) and **codex** (OpenAI Codex CLI).
`opencode` is a config-only stub for a future addition.

**Why the Node ESM rewrite?** The bash hooks forked ~6–7 processes per invocation under a 10 s
msys timeout and were intermittently killed ("hooks not triggering sometimes"). Each hook is now
**one fork-free Node process** — read payload, gate with real `JSON.parse`, route in-process, emit
— well under any timeout. The dead `Workflow` PreToolUse guard was also dropped (empirically never
fired — Claude Code doesn't dispatch `PreToolUse` to a `Workflow` matcher).

---

## Backend quirks you must know

### agy needs a TTY — provided by node-pty

`agy` only prints output when attached to a TTY (it gates on `isatty(stdout)`). Run through a plain
pipe it **exits 0 and prints nothing** — a silent no-op that looks like success. The plugin runs
every agy call under a real **pseudo-terminal via [`node-pty`](https://github.com/microsoft/node-pty)**
(ConPTY on Windows 10/11, forkpty on Linux/macOS), so `isatty` is true and agy emits — **with no
visible console window, working even from a fully headless parent** (a Bash-tool call, a hook, a
`/team` or `/reasoning` sub-agent). The prompt is passed as a real argv element (no shell —
injection-safe), and `clean()` strips the terminal control bytes the pty emits. Handled in
`src/lib/backends.mjs` (`runPty`).

**Earlier versions** wrapped agy in **winpty** + an idle-held stdin. winpty needs a real Windows
console, which a headless parent can't provide (the `winpty.cc:924` assertion) — so agy was a silent
no-op outside a real terminal and fell through to codex/native. node-pty (ConPTY) removes that
limitation. Full findings in [PROBES.md](PROBES.md).

### codex is non-interactive — no TTY needed

`codex` is invoked as `codex exec <flags>` with the **prompt delivered via stdin** (`codex -`),
not as a command-line argument. This fixes a real Windows bug where the npm `.cmd` shim spawned
via `cmd.exe` truncated a multi-line prompt at the first newline. `resolveBinary` prefers a
PATHEXT match (`codex.cmd`) over the extensionless npm shim, and `.cmd`/`.bat` wrappers are
spawned via `cmd.exe /d /s /c`. No winpty, no stdin-keepalive pipe needed.

**Requirements:**

- **Node.js >= 18** (the runtime for all plugin scripts).
- **`node-pty`** (the one native dependency — gives the agy lane its pseudo-terminal). Resolve it
  **either** way; the agy invoker tries a plugin-local install first, then a **global** one via a
  `NODE_PATH` shim (the same trick oh-my-claudecode uses):
  - **`npm install -g node-pty`** — recommended **one-time** global install. It then resolves across
    every plugin update with no per-update setup. ← do this once.
  - or `npm install` inside the plugin folder (local; must be re-run after each update).
  - Prebuilt binaries cover common Node/OS/arch combos (no toolchain needed in the normal case).
  - **Required on Windows** (ConPTY; no `script` equivalent). **Optional on Linux/macOS** — if node-pty
    is absent there, the agy lane falls back to the system **`script`** utility (present on virtually
    every box), so POSIX needs no native dep. If neither node-pty nor `script` is available, agy
    degrades gracefully to the codex/native fallback (with an install hint in the handoff reason).
- **agy** — must be installed and pre-authed. Binary auto-resolved from `$MMT_AGY_BIN` → PATH →
  `$LOCALAPPDATA/agy/bin/agy.exe` (Windows) or `~/.local/bin/agy` / `/usr/local/bin/agy` (POSIX).
- **codex** (optional) — `npm install -g @openai/codex` and log in. If absent or disabled,
  tasks fall through to the next hop in the fallback chain.

**Cross-platform note:** agy's TTY is provided by `node-pty` (ConPTY on win32, forkpty on POSIX);
winpty is no longer required. Developed and tested on Windows; Linux/macOS paths are wired up but not
yet exercised on a real POSIX box.

---

## Install

This repo *is* the plugin. Point Claude Code at it as a local plugin (e.g. via a local
marketplace or `--plugin-dir`). On enable, Claude Code auto-discovers `commands/`,
`agents/`, and `hooks/hooks.json`.

### Statusline HUD (manual, one-time)

A plugin-bundled `settings.json` does **not** register a top-level `statusLine` (Claude Code
only honors the `agent`/`subagentStatusLine` keys there). The shipped `settings.json` is a
reference only — to get the HUD, add this to **your own `~/.claude/settings.json`**, with the
**absolute** path to where this plugin lives:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/you/path/to/multi-model-team/statusline/statusline.mjs\""
  }
}
```

`statusline.mjs` degrades cleanly: if it can't read state it just prints `◦ mmt idle`.

HUD lines:

```
⟳ agy·Gemini-3.1-Pro │ 2 open │ ~12k↓        (active delegation)
◦ agy idle │ 5 calls · 1 fallback │ last 3.4s ✓   (idle)
◦ mmt idle                                    (no calls yet)
```

Token totals are **char estimates** (prefixed `~`) — agy emits no usage line.

---

## Usage

### Commands

- **`/multi-model-team:team [N:gemini,M:claude] <task>`** — **multi-model team pipeline.**
  A staged **plan → exec → verify → fix** pipeline: **agy, codex and native Claude are equal,
  configurable tools** — the decomposer assigns each subtask to its best-fit backend and any
  backend can be the verifier (defaults — agy/codex/native eligible, codex verifies — live in the
  roster `team` section and overridable per invocation). Claude decomposes the task,
  **dispatches** each subtask **to its assigned backend** (CLI backends in parallel, judgment/hard-line
  on native Claude), **verifies** each result against an acceptance criterion on the configured
  verifier, **fixes** failures in a bounded loop, then **synthesizes**.
  - **Dependency-aware:** subtasks declare `deps`; dependents run *after* their upstreams and
    receive those results as context (dispatch proceeds in waves, not one flat batch).
  - **Verify → fix:** every result is reviewed by **codex** (scoped to code review / tests /
    verification; native Claude falls back if codex is unavailable). Failures are re-dispatched
    to the same backend with the verifier's feedback (default 1 fix attempt; still-failing subtasks
    are flagged, not hidden). A bare `MMT_NATIVE_HANDOFF` (agy unavailable) counts as a fail and
    is solved natively.
  - Optional leading **agent cap** like `5:gemini,2:claude` (order-agnostic; `gemini`=agy,
    `claude`=native; aliases `agy`/`native`/`flash`/`pro`/`sonnet`/`opus`; default `4:gemini,2:claude`).
  - **Parallel agents (OMC-style):** `/team` fans every subtask out as its **own sub-agent running
    in parallel** — CLI subtasks via a faithful `node src/bin/run.mjs` relay worker, native subtasks
    via a solver worker — never one inline session.
  - **Ultracode:** if the Workflow tool is available, `/team` runs the whole pipeline as a
    deterministic dynamic workflow (`workflows/team.mjs`) with knobs `verify` (default on),
    `verifier` (`codex` default, or `native`), and `maxFixLoops` (default 1, max 3). Agents show
    backend-prefixed in the progress tree (`gemini:` / `codex:` / `native:`), and each native
    subtask's model is chosen **by complexity** — `sonnet` for ordinary work, `opus` only for
    genuinely hard subtasks.
  - Task text is never shell-interpolated — it's written to a `plan.json` (data) and fed to
    `run.mjs` on stdin, so it's injection-safe.
- **`/multi-model-team:reasoning [panel-spec] <question>`** — **multi-model Fusion pipeline.**
  Fan the same question out to a **configurable panel of models** in parallel (default panel is set
  in roster `reasoning.panel` — edit it to change which models participate; default: Opus+Sonnet+Gemini),
  have a **judge** compare their answers into a structured analysis (consensus / contradictions / unique
  insights / blind spots), then **synthesize** one unified answer that is better than any single
  model's.
  - **Panel spec** (optional leading arg): `2:gemini,opus,codex` — token aliases map to
    `{backend, tier}` pairs; a count prefix (e.g. `3:gemini`) adds N copies for self-consistency.
    Unknown tokens are ignored with a note. Default panel: Opus + Sonnet + Gemini.
  - **Parallel dispatch:** every panelist runs independently and simultaneously — native panelists
    as real sub-agents pinned to their model, CLI panelists via a faithful `run.mjs` relay
    (`rule:"reason"`); a CLI unavailable → visible native fallback (never a silent substitution).
  - **Judge:** structured analysis over all panel answers: `consensus` (high-confidence points most
    agreed on), `contradictions`, `unique_insights` (from a single panelist), `blind_spots`
    (angles none addressed).
  - **Synthesis:** one unified answer folding in consensus, unique insights, and blind spot
    remediation, with the panel/judge appendix shown.
  - **Ultracode:** if the Workflow tool is available, `/reasoning` runs the entire Fusion pipeline
    as `workflows/reasoning.mjs` (deterministic, dependency-safe, `Panel → Judge → Synthesize`).
    Otherwise parallel `Task` agents fan out the panel, then the lead judges and synthesizes.
  - Panel roles and defaults live in the roster `reasoning` section (see Tuning).
  - Question text is injection-safe — it rides on a single-quoted heredoc or a JSON `args` value,
    never the command line.
- **`/multi-model-team:route-test <task>`** — dry-run the router. Prints the decision
  (chars, detected types, matched rule, `{backend, model, tier}`). No backend call. Tuning tool.

### Agents (Claude spawns these on its own for matching work)

- **`agy`** — standard, verifiable coding + Gemini's edges where the result is compact or easy
  to verify (UI/CSS/scaffolding/scripts/SQL/regex/configs), plus web-research/doc summarization
  and bulk text ingestion. Not for RE/systems-hard.
- **`codex`** — delegate **code review, test-writing, and verification** to the OpenAI Codex
  CLI (`dispatch: forced`): review a diff/file for correctness, bugs, and edge cases; write or
  extend a test suite; or verify an implementation meets its spec. Not for RE/injection/systems-hard.

There is intentionally **no** RE/injection agent — that work stays **native by default**. An
explicit agent spawn is honored as-is (forces that backend through `run.mjs`, not bounced by the
router's hard line). Don't spawn one for RE unless you mean it.

### Proactive delegation (opt-in)

By default the model only offloads when *it* decides to spawn one of the agents above, or when
you run `/team`. Two opt-in, config-gated hooks make it reach for a backend on its own:

1. **Prompt nudge — `UserPromptSubmit`** (`hooks/proactive-route.mjs`). On every prompt you
   submit it routes in-process; when the prompt would route to a CLI backend it injects a one-shot
   reminder nudging Claude to delegate it (the `agy`/`codex` agent / `/team`) instead of
   solving it inline.
2. **Spawn guard — `PreToolUse` on `Task`/`Agent`** (`hooks/spawn-route-guard.mjs`). The
   "outside `/team`" enforcer: whenever Claude spawns an agent whose task routes to **agy or
   codex**, the guard makes that work actually run on the CLI — a non-blocking nudge by default,
   or a hard block when `enforce_spawns` is on. Your own `/team` workers and the plugin's
   subagents are exempt; native-routing spawns are left alone. **oh-my-claudecode interop:** an
   OMC team worker is **always nudged, never denied** — even under `enforce_spawns` — so it can't
   stall OMC's team; the nudge tells that worker to run its task through our `run.mjs` while it
   keeps following OMC's TaskList/SendMessage protocol.

Both fire deterministically; in nudge mode whether Claude complies is still its judgment. **Off by
default.** Turn on and tune in `config/roster.json`:

```jsonc
"proactive": {
  "enabled": true,         // master switch for BOTH hooks (default false)
  "max_chars": 0,          // only act when the prompt/task is <= N chars (0 = no cap)
  "min_chars": 0,          // only act when the prompt/task is >= N chars (0 = no floor)
  "rules": "",             // CSV allowlist of route names; empty = any CLI route
  "guard_spawns": true,    // (2) intercept Task/Agent spawns that route to agy/codex
  "enforce_spawns": false  // (2) false = nudge; true = hard-deny + require CLI re-dispatch
}
```

Slash commands and anything that routes to native Claude (judgment / RE / systems) are never
touched. When disabled both hooks exit immediately (no child forks), costing nothing. Hard kill
switch: `MMT_PROACTIVE_DISABLE=1`.

---

## How routing works

`src/bin/route.mjs` scores the task (char count + keyword type classification from `config/tags.txt`),
then matches `routes` rules in `config/roster.json` (first match wins; order encodes priority).
`src/bin/run.mjs` executes the chosen backend with a fallback chain, writes HUD state, and cleans
the output.

| Goes to **agy / codex** (CLI backends) | Goes to **Sonnet** | Goes to **Opus** (hard line) |
|---|---|---|
| New components, CSS, UI, SVG/anim | Refactoring *existing* code | RE, IL2CPP, protobuf-RE |
| Boilerplate, scaffold, CRUD, REST | Cross-module integration | disasm, decompile, VMProtect |
| Scripts, CLI tools, glue code | Bugfixes needing root-cause | DLL injection, Detours/MinHook |
| SQL, regex, configs, Dockerfiles | API/data-model *design* | FFI, unsafe, shellcode, kernel |
| Fixtures, data transforms, codegen | Production logic, edge cases | concurrency, lock-free, KCP |
| Web search, doc/research summary | Anything hard to verify | protocol design, proc-macros |
| Video/audio (Claude can't anyway) | Unclassified / uncertain | (size-irrelevant — always Opus) |

Within the CLI lane: **code review, test-writing (unit / integration / e2e), and verification →
`codex`**; the rest of the commodity work → **`agy`**. (A judgment word like *refactor* or
*bugfix* still wins → Sonnet; the hard line still → Opus.) Default fallback chain: **agy → codex
→ native**.

**Presets** (`defaults.preset` in roster.json, or `--preset`):
`budget` pushes borderline judgment-coding down to a CLI backend; `premium` pulls standard-coding
up to Sonnet; `balanced` is the default.

### Tuning

All config lives in one JSON file, **`config/roster.json`** — sections with `_comment`/`_about`
keys as inline docs:

- **`backends`** — each CLI a route can target. Flip `enabled` to turn a backend on/off; `kind`
  picks the invoker in `src/lib/backends.mjs`. Two live backends:
  - **`agy`** (`kind:"gemini"`) — Gemini CLI; runs under a node-pty pseudo-terminal (see above).
  - **`codex`** (`kind:"codex"`) — prompt delivered via stdin; no pty needed.
  - **`opencode`** is a disabled stub for a future addition.
- **`agents`** — the delegation subagents. Each has `enabled`, `backend`, `tier`, `dispatch`
  (`route` or `forced`), and a `role`. **After editing, run
  `node src/lib/gen-agents.mjs`** — it regenerates `agents/*.md` from the JSON (and removes the
  `.md` of any disabled agent).
- **`routes`** — first-match-wins routing rules. Edit to change *where a type routes*.
- **`team`** — the `/team` pipeline roles + defaults. **native, agy and codex are equal** — any
  can be assigned any subtask and any can verify.
- **`reasoning`** — the `/reasoning` Fusion pipeline defaults. **`panel` is user-configurable** —
  edit it to change which models participate by default (e.g. `["opus","sonnet","gemini","codex"]`
  for a 4-model panel, or `["gemini","codex"]` for a CLI-only panel). Also configures `judge`,
  `synthesizer`, `cap`, `tier_models`, `relay_model`. See `docs/REASONING.md` for the full token
  vocabulary and override precedence. Per-invocation spec (e.g. `2:gemini,opus`) always wins.
- **`defaults`** / **`proactive`** — preset + fallback chain, and the proactive-nudge config.
- **`config/tags.txt`** (separate flat file) — keyword→type classification. Edit to change *what
  type* a task is detected as.

Routing changes need no code edit — verify with `/route-test`. Agent changes need a
`node src/lib/gen-agents.mjs` run. Adding a future backend: add `invoke`/`health` dispatch cases
in `src/lib/backends.mjs` and flip `enabled`; no other code changes.

---

## Layout

```
.claude-plugin/plugin.json      plugin manifest
settings.json                   statusLine registration reference
config/roster.json              ALL config: defaults + backends + agents + routes + proactive + team
config/tags.txt                 task-type classifier (editable flat file, no code edits)
src/lib/platform.mjs            cross-platform OS layer: PTY wrap, binary resolve, state dir
src/lib/config.mjs              roster.json loader (replaces config.py)
src/lib/score.mjs               char count + keyword type classification (replaces score.sh)
src/lib/router.mjs              first-match-wins decision engine (replaces match.py)
src/lib/backends.mjs            agy/codex invokers + clean() + quota detection (replaces backends.sh)
src/lib/state.mjs               HUD state read/write (replaces state.sh)
src/lib/hook-common.mjs         shared hook runtime: one-fork-free node process per hook
src/lib/team-spec.mjs           /team cap-spec parser (replaces team_spec.py)
src/lib/team-plan.mjs           plan.json → per-subtask files (replaces team_plan.py)
src/lib/reason-spec.mjs         /reasoning panel-spec parser (expandPanel / parsePanel / splitPanel)
src/lib/gen-agents.mjs          regenerate agents/*.md from roster.json (replaces gen_agents.py)
src/bin/route.mjs               task → decision JSON CLI (replaces route.sh)
src/bin/run.mjs                 executor + fallback chain + HUD state (replaces run.sh)
src/bin/team.mjs                scripted CLI-backend fan-out for /team (replaces team.sh)
src/bin/reason.mjs              scripted panel fan-out engine for /reasoning (no-agents path)
hooks/proactive-route.mjs       UserPromptSubmit delegation nudge (opt-in)
hooks/spawn-route-guard.mjs     PreToolUse(Task|Agent) guard — nudge/deny CLI-routable spawns (opt-in)
hooks/hooks.json                hook registrations (all commands: node <hook>.mjs)
statusline/statusline.mjs       fork-free HUD line (replaces statusline.sh)
agents/                         agy, codex (GENERATED)
commands/                       team, route-test, reasoning
workflows/team.mjs              Ultracode dynamic-workflow fan-out (Workflow tool)
workflows/reasoning.mjs         Ultracode Fusion workflow: Panel → Judge → Synthesize
test/*.test.mjs                 offline test suite (npm test)
docs/PLAN.md                    original implementation plan (historical)
docs/REASONING.md               design contract for the /reasoning Fusion pipeline
```

---

## Testing

```bash
npm test                        # offline: 81/81 routing + unit tests (no backend calls)
MMT_LIVE=1 npm test             # also run live agy + codex smoke tests (network required)
```

---

## Known open items

- **P2 — quota error grounding:** `quota_patterns` in `roster.json` are sensible defaults. Quota
  detection is **failure-gated** (`backends.quotaFromResult`) — a successful call (exit 0 +
  non-empty output) is never read as exhaustion, so a backend answer that merely *quotes* a pattern
  word (e.g. codex reading this repo's `quota_patterns` during a review) is no longer discarded and
  bounced to fallback. Harden `quota_patterns` / `quota_exit_codes` on the first real
  agy/codex credit-exhaustion error.
- **Hook scope:** the `PreToolUse` guard intentionally matches only `Read` for now (start
  narrow, widen on evidence).
- **Linux/macOS:** POSIX PTY shim (`script`) and XDG state dir are wired up in `platform.mjs`
  but not yet exercised on a real POSIX box.

## Env overrides

| Var | Purpose |
|---|---|
| `MMT_AGY_BIN` | explicit path to the agy binary |
| `MMT_CODEX_BIN` | explicit path to the codex binary |
| `MMT_ROSTER` | alternate roster.json |
| `MMT_TAGS` | alternate tags.txt |
| `MMT_STATE_DIR` / `MMT_STATE_FILE` | HUD state location |
| `MMT_STDIN_KEEPALIVE_SECS` | how long the open-stdin pipe to agy is held (default 600) |
| `MMT_PROACTIVE_DISABLE` | `=1` hard-disables both proactive hooks |
| `MMT_HOOK_DISABLE` | `=1` hard-disables the plugin hooks |
| `MMT_HOOK_DEBUG` | `=1` appends firing markers to stateDir/hooks.log |
