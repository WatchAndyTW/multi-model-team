<div align="center">

# 🧩 multi-model-team

**Let Claude Code delegate the grunt work to Gemini & Codex — and keep the hard thinking for itself.**

Multi-model orchestration for Claude Code. Route by task, fan out in parallel, fall back gracefully.

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Type](https://img.shields.io/badge/module-ESM-f7df1e)
![Tests](https://img.shields.io/badge/tests-87%2F87%20passing-3fb950)
![Platforms](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20macOS-555)
![Deps](https://img.shields.io/badge/runtime%20deps-1%20(node--pty)-blue)

</div>

---

A Claude Code **plugin** that offloads token-heavy, self-contained tasks to local pre-authed CLI
backends — **`agy`** (Gemini) and **`codex`** (OpenAI Codex CLI) — picking the backend and model by
task size and type, with credit-exhaustion fallback through the chain to native Claude, and a
glanceable statusline HUD.

The core idea:

> **Offload commodity work** (UI/components, scaffolding, CRUD, scripts, SQL, configs, unit tests,
> web research, bulk summarization) to a fast/cheap CLI — **keep judgment-heavy and systems-hard
> work** (reverse-engineering, FFI/unsafe, injection, concurrency, protocol design) on Claude.
> Every routing decision is config-driven; tune it without touching code.

**agy, codex, and native Claude are equal, configurable tools.** `/team` decomposes a task and
assigns each subtask to its best-fit backend; `/reasoning` fans one question across a panel of all
three and fuses the answers.

---

## ⚡ Quick Start

**1 · Install the backends** (one-time, pre-auth each)

```bash
npm install -g node-pty       # the one native dep — gives agy a pseudo-terminal (see note below)
npm install -g @openai/codex  # then: codex login

# Windows Powershell
irm https://antigravity.google/cli/install.ps1 | iex         # then: agy login

# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash  # then: agy login
```

**2 · Add the plugin.** This repo *is* the plugin — point Claude Code at it as a local plugin (local
marketplace or `--plugin-dir`). On enable, Claude Code auto-discovers `commands/`, `agents/`, and
`hooks/hooks.json`. Nothing else to wire up.

**3 · (Optional) Turn on the HUD.** Add a `statusLine` to **your own** `~/.claude/settings.json`
(the plugin can't register one for you) — see [Statusline HUD](#-statusline-hud).

**4 · Use it.**

```
/reasoning  2:gemini,opus,codex   What's the best caching strategy for a read-heavy API?
/team       3:gemini,1:codex      Build a REST CRUD service with tests
/route-test                       Write a SQL query to list users by signup date   ← dry-run, no call
```

…or just work normally and let Claude reach for the `agy` / `codex` agents on its own.

---

## 🎛️ Commands

| Command | What it does |
|---|---|
| **`/reasoning [panel] <question>`** | **Fusion pipeline.** Fan one question across a panel of models in parallel → a judge compares them (consensus / contradictions / unique insights / blind spots) → synthesize one unified answer better than any single model's. |
| **`/team [N:gemini,M:claude,X:codex] <task>`** | **Team pipeline.** Decompose → dispatch each subtask to its best-fit backend (dependency-aware waves) → verify each result → bounded fix loop → synthesize. |
| **`/route-test <task>`** | Dry-run the router: prints `{backend, model, tier}`, detected types, matched rule. No backend call — a tuning tool. |

Both `/team` and `/reasoning` have **two engines**: an **Ultracode** deterministic Workflow path
(preferred, when the Workflow tool is available) and a parallel `Task`-agent fallback. Either way the
work runs across parallel agents — never one inline session.

### Agents (Claude spawns these on its own for matching work)

| Agent | Use for | Backend |
|---|---|---|
| **`agy`** | Standard, verifiable coding + Gemini's edges (compact/checkable results) | agy |
| **`codex`** | Code review, test-writing, verification | codex |

There is intentionally **no RE/injection agent** — that work stays **native by default**. An explicit
agent spawn is honored as-is (forces that backend; the router's hard line won't bounce it).

---

## 🚦 How routing works

`src/bin/route.mjs` scores the task (char count + keyword types from `config/tags.txt`), then matches
`routes` rules in the roster (first match wins; order encodes priority). `src/bin/run.mjs` runs the
chosen backend with a fallback chain, writes HUD state, and cleans output.

| → **agy / codex** (CLI) | → **Sonnet** (judgment) | → **Opus** (hard line) |
|---|---|---|
| New components, CSS, UI, SVG/anim | Refactoring *existing* code | RE, IL2CPP, protobuf-RE |
| Boilerplate, scaffold, CRUD, REST | Cross-module integration | disasm, decompile, VMProtect |
| Scripts, CLI tools, glue code | Bugfixes needing root-cause | DLL injection, Detours/MinHook |
| SQL, regex, configs, Dockerfiles | API / data-model *design* | FFI, unsafe, shellcode, kernel |
| Fixtures, data transforms, codegen | Production logic, edge cases | concurrency, lock-free, KCP |
| Web search, doc/research summary | Anything hard to verify | protocol design, proc-macros |
| Video/audio (Claude can't anyway) | Unclassified / uncertain | (size-irrelevant — always Opus) |

Within the CLI lane: **code review, test-writing, and verification → `codex`**; the rest of the
commodity work → **`agy`**. A judgment word (*refactor*, *bugfix*) still wins → Sonnet; the hard line
still → Opus. Default fallback chain: **agy → codex → native**.

**Presets** (`defaults.preset`, or `--preset`): `budget` pushes borderline judgment-coding to a CLI;
`premium` pulls standard-coding up to Sonnet; `balanced` is the default.

---

## ⚙️ Configuration

All config lives in **one JSON file**, and resolution is **file-based** (no env var) — drop a file
in the right place and every entry point picks it up automatically, so plugin updates never clobber
your tuning. Run **`/mmt-setup`** to scaffold your personal roster.

**Roster resolution order** (highest first):

1. **`<cwd>/.mmt/roster.json`** — project-local roster: per-repo tuning, checked into the project so a
   team shares one routing config.
2. **`~/.claude/mmt-roster.json`** — your personal roster across all projects (created by `/mmt-setup`).
3. `<plugin>/config/roster.json` — the shipped default.

Sections (keys prefixed `_comment`/`_about` are inline docs the parsers ignore):

| Section | Tune to… |
|---|---|
| **`backends`** | turn a CLI on/off (`enabled`), pick its invoker (`kind`). Live: `agy` (`gemini`), `codex`. `opencode` is a stub. |
| **`routes`** | change *where* a task type routes (first match wins). |
| **`agents`** | the delegation subagents (`backend`/`tier`/`dispatch`/`role`). **After editing, run `node src/lib/gen-agents.mjs`** to regenerate `agents/*.md`. |
| **`team`** | the `/team` pipeline roles + defaults — `dispatch_backends`, `verifier`, `caps`, `tier_models`, `verify`, `max_fix_loops`. |
| **`reasoning`** | the `/reasoning` Fusion defaults — **`panel`** (which models participate), `judge`, `synthesizer`, `cap`. See [docs/REASONING.md](docs/REASONING.md). |
| **`defaults`** / **`proactive`** | preset + fallback chain, and the proactive-nudge config. |
| **`config/tags.txt`** | (separate flat file) keyword → task-type classification. |

Routing changes need no code edit — verify with `/route-test`. Adding a future backend: add
`invoke`/`health` cases in `src/lib/backends.mjs` and flip `enabled`.

### Proactive delegation (opt-in, off by default)

Two config-gated hooks make Claude reach for a backend on its own instead of waiting for you to ask:

1. **Prompt nudge** (`UserPromptSubmit`) — when a prompt would route to a CLI backend, injects a
   one-shot reminder to delegate instead of solving inline.
2. **Spawn guard** (`PreToolUse` on `Task`/`Agent`) — when Claude spawns an agent whose task routes
   to agy/codex, makes that work actually run on the CLI (nudge by default; hard block under
   `enforce_spawns`). Your `/team` workers and the plugin's own subagents are exempt; **oh-my-claudecode
   team workers are always nudged, never denied**, so they never stall.

```jsonc
"proactive": {
  "enabled": true,          // master switch for BOTH hooks (default false)
  "max_chars": 0, "min_chars": 0,  // size window (0 = unbounded)
  "rules": "",              // CSV allowlist of route names; empty = any CLI route
  "guard_spawns": true,     // (2) intercept agy/codex-routable Task/Agent spawns
  "enforce_spawns": false   // (2) false = nudge; true = hard-deny + require CLI re-dispatch
}
```

Slash commands and native-routing work are never touched. Disabled → both hooks exit immediately
(zero forks). Hard kill switch: `MMT_PROACTIVE_DISABLE=1`.

---

## 📺 Statusline HUD

A plugin-bundled `settings.json` does **not** register a top-level `statusLine`. The shipped
`settings.json` is a reference — to get the HUD, add this to **your own** `~/.claude/settings.json`
with the **absolute** path to this plugin:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/you/path/to/multi-model-team/statusline/statusline.mjs\""
  }
}
```

```
⟳ agy·Gemini-3.1-Pro │ 2 open │ ~12k↓             (active delegation)
◦ agy idle │ 5 calls · 1 fallback │ last 3.4s ✓    (idle)
◦ mmt idle                                         (no calls yet)
```

Token totals are char estimates (prefixed `~`) — agy emits no usage line. If it can't read state, it
prints `◦ mmt idle`.

---

## 🔌 Backend quirks worth knowing

### agy needs a TTY — provided by `node-pty`

`agy` gates output on `isatty(stdout)`: through a plain pipe it **exits 0 and prints nothing** — a
silent no-op that looks like success. The plugin runs every agy call under a real **pseudo-terminal
via [`node-pty`](https://github.com/microsoft/node-pty)** (ConPTY on Windows 10/11, forkpty on
Linux/macOS), so `isatty` is true and agy emits — **with no visible console window, working even from
a fully headless parent** (a Bash-tool call, a hook, a `/team` or `/reasoning` sub-agent). The prompt
rides as a real argv element (no shell — injection-safe).

> **node-pty resolution:** `npm install -g node-pty` once and it resolves across every plugin update
> via a `NODE_PATH` shim (the trick oh-my-claudecode uses); or `npm install` locally (re-run per
> update). **Required on Windows** (ConPTY). **Optional on Linux/macOS** — the agy lane falls back to
> the system `script` utility; if neither exists, agy degrades to the codex/native fallback with an
> install hint.

### codex is non-interactive — no TTY needed

`codex` is invoked as `codex exec <flags>` with the **prompt delivered via stdin** (fixes a Windows
bug where the npm `.cmd` shim truncated multi-line prompts at the first newline). `resolveBinary`
prefers a PATHEXT match (`codex.cmd`) over the extensionless shim. No pty needed.

---

## 📋 Requirements

- **Node.js ≥ 18** — runtime for all plugin scripts.
- **`node-pty`** — the one native dep (agy's pseudo-terminal). Prebuilt binaries cover common
  Node/OS/arch combos. Required on Windows; optional on POSIX (see note above).
- **agy** (Antigravity CLI, optional) — installed and pre-authed. Auto-resolved from `$MMT_AGY_BIN` → PATH →
  `$LOCALAPPDATA/agy/bin/agy.exe` (Windows) or `~/.local/bin/agy` / `/usr/local/bin/agy` (POSIX).
- **codex** (Codex CLI, optional) — `npm install -g @openai/codex` + login. If absent, tasks fall through the chain.

Built and verified against **agy v1.0.8** and **codex-cli 0.139.0** on Windows. Linux/macOS paths are
wired up but not yet exercised on a real POSIX box.

---

## 🗂️ Layout

```
.claude-plugin/plugin.json   plugin manifest
config/roster.json           shipped default config (override at ~/.claude/mmt-roster.json)
config/tags.txt              task-type classifier (editable flat file)
src/lib/platform.mjs         cross-platform OS layer: PTY wrap, binary + roster resolve, state dir
src/lib/config.mjs           roster loader → plain JS objects
src/lib/score.mjs            char count + keyword type classification
src/lib/router.mjs           first-match-wins decision engine
src/lib/backends.mjs         agy/codex invokers + clean() + quota detection
src/lib/state.mjs            HUD state read/write
src/lib/hook-common.mjs      shared hook runtime (one fork-free node process per hook)
src/lib/team-spec.mjs        /team cap-spec parser
src/lib/team-plan.mjs        plan.json → per-subtask files
src/lib/reason-spec.mjs      /reasoning panel-spec parser
src/lib/gen-agents.mjs       regenerate agents/*.md from the roster
src/bin/route.mjs            task → decision JSON CLI
src/bin/run.mjs              executor + fallback chain + HUD state (base64url relay transport)
src/bin/team.mjs             scripted CLI fan-out for /team
src/bin/reason.mjs           scripted panel fan-out for /reasoning
hooks/proactive-route.mjs    UserPromptSubmit delegation nudge (opt-in)
hooks/spawn-route-guard.mjs  PreToolUse(Task|Agent) guard — CLI-routable spawns (opt-in)
hooks/command-fanout-guard.mjs  UserPromptSubmit guard — forces /reasoning & /team into the engine
hooks/hooks.json             hook registrations
statusline/statusline.mjs    fork-free HUD line
agents/                      agy, codex (GENERATED)
commands/                    reasoning, team, route-test
workflows/team.mjs           Ultracode team workflow
workflows/reasoning.mjs      Ultracode Fusion workflow: Panel → Judge → Synthesize
test/*.test.mjs              offline test suite
docs/PLAN.md                 original implementation plan (historical)
docs/REASONING.md            design contract for the /reasoning Fusion pipeline
```

---

## 🧪 Testing

```bash
npm test                # offline: 87/87 routing + unit tests (no backend calls)
MMT_LIVE=1 npm test     # also run live agy + codex smoke tests (network required)
```

> **Why Node ESM?** The original bash hooks forked ~6–7 processes per invocation under a 10 s msys
> timeout and were intermittently killed ("hooks not triggering sometimes"). Each hook is now **one
> fork-free Node process** — read payload, gate with real `JSON.parse`, route in-process, emit.

---

## 🔧 Env overrides

| Var | Purpose |
|---|---|
| `MMT_AGY_BIN` / `MMT_CODEX_BIN` | explicit path to the agy / codex binary |
| `MMT_TAGS` | alternate `tags.txt` |
| `MMT_STATE_DIR` / `MMT_STATE_FILE` | HUD state location |
| `MMT_PROACTIVE_DISABLE` | `=1` hard-disables both proactive hooks |
| `MMT_HOOK_DISABLE` | `=1` disables all hooks |
| `MMT_COMMAND_GUARD_DISABLE` | `=1` disables just the `/reasoning`·`/team` engine guard |
| `MMT_HOOK_DEBUG` | `=1` appends firing markers to `stateDir/hooks.log` |

---

## 🐛 Known open items

- **Quota grounding (P2):** `quota_patterns` are sensible defaults; detection is failure-gated (a
  successful call is never read as exhaustion). Harden on the first real credit-exhaustion error.
- **Linux/macOS:** POSIX PTY shim (`script`) and XDG state dir are wired up but not yet exercised on a
  real POSIX box.

## License

MIT
