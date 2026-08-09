<div align="center">

# 🧩 multi-model-team

**Let Claude Code delegate the grunt work to Gemini, Codex & OpenCode — and keep the hard thinking for itself.**

Multi-model orchestration for Claude Code. Route by task, fan out in parallel, fall back gracefully.

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Type](https://img.shields.io/badge/module-ESM-f7df1e)
![Tests](https://img.shields.io/badge/tests-189%2F189%20passing-3fb950)
![Platforms](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20macOS-555)
![Deps](https://img.shields.io/badge/runtime%20deps-1%20(node--pty)-blue)

</div>

---

A Claude Code **plugin** that offloads token-heavy, self-contained tasks to local pre-authed CLI
backends — **`agy`** (Gemini), **`codex`** (OpenAI Codex CLI) and **`opencode`** (OpenCode CLI) —
picking the backend and model by task size and type, with credit-exhaustion fallback through the
chain to native Claude, and a glanceable statusline HUD.

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
marketplace or `--plugin-dir`). On enable, Claude Code auto-discovers `commands/` and `agents/`.
Nothing else to wire up.

**3 · (Optional) Turn on the HUD.** Add a `statusLine` to **your own** `~/.claude/settings.json`
(the plugin can't register one for you) — see [Statusline HUD](#-statusline-hud).

**4 · Use it.**

```
/reasoning  2:gemini,opus,codex   What's the best caching strategy for a read-heavy API?
/team       3:gemini,1:codex      Build a REST CRUD service with tests
```

…or just work normally and let Claude reach for the `agy` / `codex` agents on its own.

---

## 🎛️ Commands

| Command | What it does |
|---|---|
| **`/reasoning [panel] <question>`** | **Fusion pipeline.** Fan one question across a panel of models in parallel → a judge compares them (consensus / contradictions / unique insights / blind spots) → synthesize one unified answer better than any single model's. |
| **`/team [--writable] [staffing] <task>`** | **Team pipeline.** You staff it: by role — `orch:claude:2;impl:opencode:1,claude:2;review:codex:2` — or just by backend (`5:gemini,2:claude`, which staffs them as the implementers). Decompose → dispatch in dependency-aware waves → verify each result → bounded fix loop → synthesize. **Anything you don't staff runs on Claude**; no CLI is auto-assigned. Add **`--writable`** to let agents actually edit code in isolated git worktrees (see below). |

Both `/team` and `/reasoning` have **two engines**: an **Ultracode** deterministic Workflow path
(preferred, when the Workflow tool is available) and a parallel `Task`-agent fallback. Either way the
work runs across parallel agents — never one inline session.

#### `/team` modes — read-only (default) vs `--writable`

`/team` runs in one of two modes:

- **read-only (default):** the CLI agents (agy/codex) stay read-only — they return text, not edits.
  Any file changes are applied by **Claude (the orchestrator) directly to your current branch**. No
  branch, no worktree, no PR is created. This is the back-compat behaviour.
- **writable (`--writable`):** each subtask gets its **own git worktree + branch** off your current
  `HEAD`; the assigned agent makes **real file changes** there (CLI backends run **full-auto** in the
  worktree). The orchestrator then **merges every subtask branch into one integration branch
  `mmt/team-<slug>`** (off `HEAD`) and **resolves any merge conflicts itself** — reading both sides and
  editing to a correct combined result, then completing the merge — so you get **one finished,
  conflict-free branch**, not a pile of worktrees to reconcile. **Your current branch is never touched**
  (no auto-merge onto it) and **no GitHub PR is created** — you merge / open a PR for the integration
  branch when ready (`git log mmt/team-<slug>`). Only a conflict the orchestrator genuinely can't
  reconcile is left for you (reported as `unresolved`, its worktree kept). Per-subtask worktrees live
  under `.mmt/worktrees/` (gitignored). The full-auto sandbox per backend is tunable via
  `writable_extra` in `roster.json`. Enable per-invocation with `--writable`, or set
  `team.mode: "writable"` in the roster.

### Agents (Claude spawns these on its own for matching work)

Each is a **dispatcher for its CLI backend** — a configurable, equal tool, not a fixed task bucket.
*Where* work routes is decided by `config/roster.json` (routes + `tags.txt`) and per-`/team`
assignments, so the "default lane" below is tunable roster policy, not a hard limit.

| Agent | Default lane (per shipped config) | Backend |
|---|---|---|
| **`agy`** | Commodity, easily-verifiable work + Gemini's edges — UI/CSS, scaffolding, CRUD, scripts, SQL, regex, configs, tests, data transforms, web-research/summarization, audio/video | agy |
| **`codex`** | Code review, test-writing, verification (and the default `/team` verifier; writes code full-auto under `--writable`) | codex |
| **`opencode`** | Whatever you want on **your own** opencode model — a local/self-hosted model, a provider the others don't cover, or a third independent opinion. No auto-route lane: it runs only when you pick it | opencode |

The shipped routing keeps RE/injection/systems-hard work **native by default** — that's roster policy
you can retune, not a property of the agents (there's intentionally no RE/injection agent). An explicit
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
| **`backends`** | turn a CLI on/off (`enabled`), pick its invoker (`kind`), map tiers to models (`models`, `model_aliases`, `default_tier`), and set `writable_extra` — the flags used **instead of** `extra` in `/team --writable` mode (full-auto). All three are live: `agy` (`gemini`), `codex`, `opencode`. |
| **`routes`** | change *where* a task type routes (first match wins). |
| **`agents`** | the delegation subagents (`backend`/`tier`/`dispatch`/`role`). **After editing, run `node src/lib/gen-agents.mjs`** to regenerate `agents/*.md`. |
| **`roles`** | **who does what in `/team`** — the role `catalog` (stage / tier / aliases / description) and `core`, the always-needed jobs with their default worker count, `follows`, and optional standing `backend`. This is the only place a job is assigned to a backend. |
| **`team`** | `/team` **pipeline knobs only** — `verify`, `max_fix_loops`, `relay_model`, and **`mode`** (`"writable"` makes `--writable` the default; per-invocation `--writable` still wins). It picks no backends. |
| **`reasoning`** | the `/reasoning` Fusion defaults — **`panel`** (which models participate), `judge`, `synthesizer`, `cap`. See [docs/REASONING.md](docs/REASONING.md). |
| **`defaults`** | preset, fallback chain, and `native_models` (the one tier → Claude-model map). |
| **`config/tags.txt`** | (separate flat file) keyword → task-type classification. |

Routing changes need no code edit — dry-run one with `node src/bin/route.mjs --explain`
(task on stdin). Adding a future backend: add
`invoke`/`health` cases in `src/lib/backends.mjs` and flip `enabled`.

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
a fully headless parent** (a Bash-tool call, a `/team` or `/reasoning` sub-agent). The prompt
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

### opencode runs on **your** model — and ignores cwd

`opencode run` also takes its **prompt on stdin** and needs no pty. Two things to know:

- **The plugin never picks a model for it.** `backends.opencode.models` ships empty, so no `--model`
  flag is passed and opencode uses whichever model *you* configured (`opencode models` to see them).
  If your default is slow, pin a faster one or raise `hard_timeout` — a local 27B default took ~40
  minutes for a one-word answer on the dev machine, past the shipped 30 m ceiling.
- **It ignores the directory it is launched in** and resolves its own project root, so the plugin
  passes `--dir` explicitly. Without that, a `/team --writable` subtask writes into your main
  checkout instead of its worktree while reporting success.

Read-only vs writable is an *agent*, not a sandbox flag: `--agent plan` normally, `--agent build
--auto` under `/team --writable`.

opencode claims **no auto-route lane** — it never quietly takes work from agy or codex. It runs when
you pick it: its agent, a `/team` assignment, a `/reasoning` panel, or the quota-fallback chain.

---

## 🎭 Staffing a team by role

`/team` can be staffed by **job**, not just by headcount:

```
/team orch:claude:2;impl:opencode:1,claude:2;review:codex:2  build a REST CRUD service
```

`role:backend:count` — commas **within** a role, semicolons **between** roles. Roles and backends
are independent, so one role can span several models (`impl:opencode:1,claude:2` = three
implementers: one on OpenCode, two on Claude). `backend:count` and `count:backend` both work, and a
bare `role:backend` means one worker.

Every role sits in a **stage**, and stages run in order:

```
plan  →  prd  →  exec  →  verify  →  fix
```

`plan` / `prd` / `exec` become subtasks, and later stages automatically receive earlier stages'
results. `verify` and `fix` staff the pipeline's own review-and-repair loop rather than being
decomposed into work of their own.

**Anything you don't staff runs on Claude** — at that role's tier, which is what picks the model.
No CLI is ever auto-assigned; it runs where you put it and nowhere else. Two conveniences on top:

- **the fixer follows the implementers**, so a fix goes back to whoever did the work — staff
  `impl:opencode:2` and opencode fixes its own subtasks (`fix:claude:1` overrides that);
- **naming backends without roles staffs them as the implementers**, which is exactly what the
  count-only spec `5:gemini,2:claude` means.

So `/team review:codex:1 <task>` = Claude does the work, codex reviews it; `/team <task>` with no
spec = the whole pipeline on Claude.

The vocabulary is [oh-my-claudecode](https://github.com/aptro/oh-my-claudecode)'s, so it should feel
familiar. `orch` / `impl` / `review` are aliases for `planner` / `executor` / `code-reviewer`, and
every specialist is nameable directly:

| stage | roles |
|---|---|
| `plan` | `explore`, `planner` (`orch`), `architect` |
| `prd` | `analyst` (`prd`), `critic` |
| `exec` | `executor` (`impl`), `designer`, `debugger`, `tracer`, `test-engineer`, `code-simplifier`, `writer`, `document-specialist`, `scientist`, `git-master` |
| `verify` | `verifier`, `code-reviewer` (`review`), `security-reviewer`, `qa-tester` |
| `fix` | `fixer` |

```bash
node src/lib/roles.mjs --list
```

prints the catalog with aliases, stages and default tiers. Each role's default tier mirrors OMC's
model choice (opus→`high`, sonnet→`standard`, haiku→`cheap`) and resolves **per backend** — so
`review:codex` runs codex's strongest model, not Opus.

The staffing is **enforced, not advisory**: a subtask naming a (role, backend) pair you didn't staff
is dropped rather than quietly moved to another model, and each worker is told which role it is
acting in — a `security-reviewer` audits for vulnerabilities instead of doing a generic pass/fail.
Staff several reviewers and a result has to satisfy all of them.

Edit `roster.json` → `roles` to retune any of it — it's config, not code: `catalog` adds or
re-tiers a role, and `core` sets what the always-needed jobs default to (including a standing
`"backend"` if you'd rather always review on codex than type it every time).

```bash
node src/lib/roles.mjs --list     # the catalog, with aliases, stages and tiers
node src/lib/roles.mjs --staff    # feed it a spec on stdin: the resolved staffing, fallbacks included
```

---

## 🔀 Turning backends on and off

`node src/bin/route.mjs --backends` shows every backend, whether it is on, what turned it off, and
each tier's model:

```
agy       enabled           kind=gemini    cheap=gemini-3.6-flash-low standard=gemini-3.1-pro-low high=gemini-3.1-pro-high
codex     DISABLED (env)    kind=codex     cheap=gpt-5.4-mini standard=gpt-5.5
opencode  enabled           kind=opencode  <no model map — the CLI uses its own default>
native    always on         kind=claude    cheap=haiku standard=sonnet high=opus
```

Three switches:

| how | scope | example |
|---|---|---|
| `backends.<name>.enabled: false` | permanent | edit the roster |
| `MMT_DISABLE_BACKENDS` | one shell | `MMT_DISABLE_BACKENDS=codex,agy` |
| `MMT_ONLY_BACKENDS` | one shell | `MMT_ONLY_BACKENDS=agy` |

Turning a backend off is honoured **at routing time**, not just at dispatch: rules targeting it are
skipped so matching continues to the next rule, and the decision names where the work really goes.
`native` can never be disabled — it is the guaranteed fallback.

## 🎚️ Choosing models

Per backend, `models` maps a tier to a model and accepts **any** tier keys (`cheap`, `standard`,
`high`, or your own). Resolution order:

```
--model flag  >  MMT_MODEL_<BACKEND>  >  exact tier  >  default_tier  >  standard  >  cheap  >  no flag
```

`model_aliases` give short handles — `--model flash` instead of `gemini-3.6-flash-low`. An empty
`models` map means "pass no flag, let the CLI decide" (how opencode is wired).
`defaults.native_models` is the one place a tier becomes a Claude model.

```bash
node src/bin/run.mjs --model flash "summarize this changelog"
```

---

## 📋 Requirements

- **Node.js ≥ 18** — runtime for all plugin scripts.
- **`node-pty`** — the one native dep (agy's pseudo-terminal). Prebuilt binaries cover common
  Node/OS/arch combos. Required on Windows; optional on POSIX (see note above).
- **agy** (Antigravity CLI, optional) — installed and pre-authed. Auto-resolved from `$MMT_AGY_BIN` → PATH →
  `$LOCALAPPDATA/agy/bin/agy.exe` (Windows) or `~/.local/bin/agy` / `/usr/local/bin/agy` (POSIX).
- **codex** (Codex CLI, optional) — `npm install -g @openai/codex` + login. If absent, tasks fall through the chain.

Built and verified against **agy v1.0.8** and **codex-cli 0.139.0** on Windows, and **tested on
Linux/macOS** — the POSIX paths are exercised on a real POSIX box.

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
src/lib/roles.mjs            /team staffing: role catalog, spec grammar, resolveStaffing
src/lib/team-spec.mjs        /team spec entry point (both grammars → one staffing table)
src/lib/team-plan.mjs        plan.json → per-subtask files
src/lib/reason-spec.mjs      /reasoning panel-spec parser
src/lib/gen-agents.mjs       regenerate agents/*.md from the roster
src/lib/validate-config.mjs  roster.json validator (route names, tiers, backends, agents)
src/bin/route.mjs            task → decision JSON CLI
src/bin/run.mjs              executor + fallback chain + HUD state (file relay transport: --call-file)
src/bin/team.mjs             scripted CLI fan-out for /team
src/bin/reason.mjs           scripted panel fan-out for /reasoning
statusline/statusline.mjs    fork-free HUD line
agents/                      agy, codex (GENERATED)
commands/                    reasoning, team, mmt-setup
workflows/team.mjs           Ultracode team workflow
workflows/reasoning.mjs      Ultracode Fusion workflow: Panel → Judge → Synthesize
test/*.test.mjs              offline test suite
docs/REASONING.md            design contract for the /reasoning Fusion pipeline
docs/INTERFACES.md           module interface contract (Node ESM port signatures)
```

---

## 🧪 Testing

```bash
npm test                # offline: 189/189 routing + unit tests (no backend calls)
```

The suite is fully offline — no backend calls. Live agy/codex behaviour is verified by hand (run a
real `node src/bin/run.mjs --call-file=…` against the installed CLIs), not by a `npm test` gate.

## 🔧 Env overrides

| Var | Purpose |
|---|---|
| `MMT_AGY_BIN` / `MMT_CODEX_BIN` | explicit path to the agy / codex binary |
| `MMT_DISABLE_BACKENDS` | CSV blocklist — `=codex,agy` turns those off for this shell |
| `MMT_ONLY_BACKENDS` | CSV allowlist — `=agy` turns everything else off |
| `MMT_MODEL_AGY` / `MMT_MODEL_CODEX` / `MMT_MODEL_OPENCODE` | override that backend's model (a real id, or a `model_aliases` handle) |
| `MMT_TAGS` | alternate `tags.txt` |
| `MMT_STATE_DIR` / `MMT_STATE_FILE` | HUD state location |

---

## 🐛 Known open items

- **Quota grounding (P2):** `quota_patterns` are sensible defaults; detection is failure-gated (a
  successful call is never read as exhaustion). Harden on the first real credit-exhaustion error.
- **Linux/macOS:** POSIX PTY shim (`script`) and XDG state dir are exercised and tested on a real
  POSIX box.

## License

MIT
