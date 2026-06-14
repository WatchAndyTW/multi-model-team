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

---

## Status

Built and verified against **agy v1.0.8** and **codex-cli 0.139.0** on Windows.
`tests/run_tests.sh` is green (125/125, including live agy + codex smoke tests). Active
backends: **agy** (Gemini) and **codex** (OpenAI Codex CLI). `opencode` is a config-only
stub for a future addition.

---

## Backend quirks you must know

### agy needs a TTY

`agy` only prints output when attached to a real console. Run through a normal pipe (a hook,
a subagent shell, `bash run.sh`) it **exits 0 and prints nothing** — a silent no-op that
looks like success. The plugin solves this by wrapping every agy call in **winpty**:

```
winpty -Xallow-non-tty -Xplain <agy.exe> --print "<prompt>" --model "<name>" ...
```

It also feeds agy an **open, idle stdin** (a held-open pipe) because agy emits nothing if
stdin is already at EOF (e.g. `/dev/null` or a drained pipe). All of this is handled in
`scripts/lib/backends.sh`. Full findings are in [PROBES.md](PROBES.md).

### codex is non-interactive — no TTY needed

`codex` is invoked as `codex exec <flags> <prompt>` and prints **only the final answer** to
stdout (session/token diagnostics go to stderr). No winpty wrapper, no stdin pipe needed.
Models default to whatever is set in codex's own `config.toml`; you can override per tier
via `roster.json` (see Tuning below).

**Requirements on Windows:** `winpty` (for agy), `python3` (any version; stdlib `json`), and
a bash (git-bash / msys). `jq` is **not** required.

- **agy** must be installed and pre-authed (binary auto-resolved from
  `$LOCALAPPDATA/agy/bin/agy.exe`, PATH, or `$MMT_AGY_BIN`).
- **codex** (optional — only needed to use the codex backend): install via
  `npm install -g @openai/codex` and log in. If it's absent or disabled, tasks fall through
  to the next hop in the fallback chain.

---

## Install

This repo *is* the plugin. Point Claude Code at it as a local plugin (e.g. via a local
marketplace or `--plugin-dir`). On enable, Claude Code auto-discovers `commands/`,
`agents/`, and `hooks/hooks.json`.

### Statusline HUD (manual, one-time)

A plugin-bundled `settings.json` does **not** register a top-level `statusLine` (Claude Code
only honors the `agent`/`subagentStatusLine` keys there, and `${CLAUDE_PLUGIN_ROOT}` isn't
expanded in user-settings scope). The shipped `settings.json` is a reference only — to get
the HUD, add this to **your own `~/.claude/settings.json`**, with the **absolute** path to
where this plugin lives:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash \"C:/Users/you/path/to/multi-model-team/statusline/statusline.sh\""
  }
}
```

`statusline.sh` degrades cleanly: if it can't read state it just prints `◦ mmt idle`.

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
  A staged **plan → exec → verify → fix** pipeline for *our* model dispatching: **agy, codex and
  native Claude are equal, configurable tools** — the decomposer assigns each subtask to its best-fit
  backend and any backend can be the verifier (defaults — agy/codex/native eligible, codex verifies —
  live in the roster `team` section and are overridable per invocation). Claude decomposes the task,
  **dispatches** each subtask **to its assigned backend** (CLI backends in parallel, judgment/hard-line
  on native Claude), **verifies** each result against an acceptance criterion on the configured
  verifier, **fixes** failures in a bounded loop, then **synthesizes**.
  - **Dependency-aware:** subtasks declare `deps`; dependents run *after* their upstreams and
    receive those results as context (dispatch proceeds in waves, not one flat batch).
  - **Verify → fix:** every result is reviewed by **codex** (the OpenAI Codex CLI, scoped to code
    review / tests / verification; native Claude falls back if codex is unavailable). Failures are
    re-dispatched to the same backend with the verifier's feedback (default 1 fix attempt;
    still-failing subtasks are flagged, not hidden). A bare `MMT_NATIVE_HANDOFF` (agy unavailable)
    counts as a fail and is solved natively.
  - Optional leading **agent cap** like `5:gemini,2:claude` (order-agnostic; `gemini`=agy,
    `claude`=native; aliases `agy`/`native`/`flash`/`pro`/`sonnet`/`opus`; default `4:gemini,2:claude`).
    It bounds how many agents of each kind run.
  - Examples: `/team scaffold a CRUD API, write its SQL, and design the data model` →
    a native agent designs the data model, then agy agents scaffold + write SQL against it.
    `/team 6:gemini,1:claude build 6 UI components and review them` → 6 agy + 1 native.
  - **Ultracode:** if the Workflow tool is available, `/team` runs the whole pipeline as a
    deterministic dynamic workflow (`workflows/team.mjs`) — knobs `verify` (default on), `verifier`
    (`codex` default, or `native`), and `maxFixLoops` (default 1, max 3) — instead of ad-hoc
    parallel calls. Agents show backend-prefixed in the progress tree (`gemini:` / `codex:` /
    `native:`), and each native subtask's model is chosen **by complexity** — `sonnet` for ordinary
    analysis, `opus` only for genuinely hard work — rather than always inheriting Opus.
  - Task text is never shell-interpolated — it's written to a `plan.json` (data) and fed to
    `run.sh` on stdin, so it's injection-safe.
- **`/multi-model-team:route-test <task>`** — dry-run the router. Prints the decision
  (chars, detected types, matched rule, `{backend, model, tier}`). No backend call. Tuning
  tool.

### Agents (Claude spawns these on its own for matching work)

- **`delegate`** — standard, verifiable coding + Gemini's edges where the result is compact
  or easy to verify. Not for RE/systems-hard.
- **`av-research`** — multimodal (video/audio/image) + grounded web-research / doc
  summarization. Highest-confidence offload (Claude can't do A/V at all).
- **`bulk-summarizer`** — pinned to agy's cheap tier; summarize/extract from very large text
  where a short grounded answer suffices.
- **`codex`** — delegate **code review, test-writing, and verification** to the OpenAI Codex
  CLI (`dispatch: forced`): review a diff/file for correctness, bugs, and edge cases; write or
  extend a test suite; or verify an implementation meets its spec. Not for RE/injection/systems-hard
  (that work is always Opus-only).

There is intentionally **no** RE/injection agent — that work is Opus-only and never offloaded.

### Proactive delegation (opt-in)

By default the model only offloads to a CLI backend when *it* decides to spawn one of the agents
above, or when you run `/team` — it won't reach for a backend on its own for small tasks. If you
want it to, there's a config-gated **`UserPromptSubmit` hook** (`scripts/hooks/proactive-route.sh`):
on every prompt you submit, it runs the same router, and **when the prompt would route to a CLI
backend it injects a one-shot reminder** nudging Claude to delegate it (the `delegate` or `codex`
agent / `/team`) instead of solving it inline. The reminder firing is deterministic; whether Claude
takes the hint is still its judgment.

It's **off by default**. Turn it on and tune it in `config/roster.json`:

```jsonc
"proactive": {
  "enabled": true,      // master switch (default false)
  "max_chars": 0,       // only nudge when the prompt is <= N chars (0 = no cap) — e.g. 1500 for "small tasks only"
  "min_chars": 0,       // only nudge when the prompt is >= N chars (0 = no floor)
  "rules": ""           // CSV allowlist of route names to nudge on (e.g. "bulk-ingest,grounded-research"); empty = any agy route
}
```

Slash commands and prompts that route to native Claude (judgment / RE / systems) are never nudged.
When disabled it bails in pure bash (no Python spawned), so it costs ~nothing. Hard kill switch:
`MMT_PROACTIVE_DISABLE=1`.

---

## How routing works

`route.sh` scores the task (char count + keyword type classification from `config/tags.txt`),
then matches `routes` rules in `config/roster.json` (first match wins; order encodes
priority). `run.sh` executes the chosen backend with a fallback chain, writes HUD state, and
cleans the output.

| Goes to **agy / codex** (CLI backends) | Goes to **Sonnet** | Goes to **Opus** (hard line) |
|---|---|---|
| New components, CSS, UI, SVG/anim | Refactoring *existing* code | RE, IL2CPP, protobuf-RE |
| Boilerplate, scaffold, CRUD, REST | Cross-module integration | disasm, decompile, VMProtect |
| Scripts, CLI tools, glue code | Bugfixes needing root-cause | DLL injection, Detours/MinHook |
| SQL, regex, configs, Dockerfiles | API/data-model *design* | FFI, unsafe, shellcode, kernel |
| Unit tests, fixtures, transforms | Production logic, edge cases | concurrency, lock-free, KCP |
| Web search, doc/research summary | Anything hard to verify | protocol design, proc-macros |
| Video/audio (Claude can't anyway) | Unclassified / uncertain | (size-irrelevant — always Opus) |

The active CLI backend for each task type is determined by the roster's routing rules. The
default fallback chain is **agy → codex → native** (if agy is exhausted or unavailable, codex
is tried before falling through to native Claude).

**Presets** (`defaults.preset` in roster.json, or `--preset`):
`budget` pushes borderline judgment-coding down to a CLI backend; `premium` pulls standard-coding
up to Sonnet (keeps CLI backends only for their categorical edges); `balanced` is the default.

### Tuning

All config lives in one JSON file, **`config/roster.json`** — five sections, with `_comment`/
`_about` keys as inline docs:

- **`backends`** — each CLI a route can target. Flip `enabled` to turn a backend on/off; `kind`
  picks the invoker. Two backends are enabled out of the box:
  - **`agy`** (`kind:"gemini"`) — Gemini CLI; requires winpty + open stdin (see above).
  - **`codex`** (`kind:"codex"`) — OpenAI Codex CLI; invoked as `codex exec <flags> <prompt>`,
    non-interactive, no winpty needed. Models default to codex's own `config.toml`; set
    `models.cheap` / `models.standard` per tier in `roster.json` to override.
  - **`opencode`** is a disabled stub for a future addition.
  Disabling a backend makes everything that would route to it fall through to the next hop / native.
- **`agents`** — the delegation subagents. Each has `enabled`, `backend`, `tier`, `dispatch`
  (`route` or `forced`), and a `role` (its description). **After editing, run
  `python scripts/lib/gen_agents.py`** — it regenerates `agents/*.md` from the JSON (and removes
  the `.md` of any agent you disabled, so Claude Code stops surfacing it).
- **`routes`** — first-match-wins routing rules. Edit to change *where a type routes*.
- **`team`** — the `/team` pipeline roles + defaults. **native, agy and codex are equal** — any can
  be assigned to any subtask and any can be the verifier: `dispatch_backends` (the eligible set the
  decomposer picks from), `verifier` (review backend, default codex; `"native"` = Claude judgment),
  `caps` (per-backend), `tier_models` (tier→model map), `verify`, `max_fix_loops`, `relay_model`. All
  overridable per `/team` invocation (cap spec `N:gemini,M:codex,K:claude`, or an in-session "verify
  with X" / "only use Y and Z"). Precedence: built-in default < `team` < invocation.
- **`defaults`** / **`proactive`** — preset + fallback chain, and the proactive-nudge config.
- **`config/tags.txt`** (separate flat file) — keyword→type classification (one `type regex`
  per line). Edit to change *what type* a task is detected as.

Routing changes need no code edit — verify with `/route-test`. Agent changes need a
`gen_agents.py` run; backend `kind`s beyond gemini need an invoker in `backends.sh`.

---

## Layout

```
.claude-plugin/plugin.json   plugin manifest
settings.json                statusLine registration
config/roster.json           ALL config (JSON): defaults + backends + agents + routes + proactive
config/tags.txt              task-type classifier (editable flat file, no code edits)
scripts/route.sh             task -> decision JSON (pure logic, no model call)
scripts/run.sh               execute backend + fallback chain + HUD state
scripts/lib/score.sh         char count + keyword type classification
scripts/lib/match.py         applies roster.json routes (json)
scripts/lib/config.py        emits roster.json as bash-sourceable vars
scripts/lib/backends.sh      backend resolution (by kind: gemini/agy, codex) + winpty invocation + clean() + quota
scripts/lib/gen_agents.py    regenerate agents/*.md from roster.json (enable/disable/role)
scripts/lib/state.sh         HUD state read/write (~/.cache/mmt/state.json)
scripts/lib/common.sh        shared helpers (python finder)
scripts/hooks/heavy-read-guard.sh   PreToolUse guard for oversized RE-dump reads
statusline/statusline.sh     fork-free HUD line
agents/                      delegate, av-research, bulk-summarizer, codex
commands/                    team, route-test
hooks/hooks.json             PreToolUse matcher
tests/run_tests.sh           offline suite + opt-in live agy smoke (MMT_LIVE=1)
```

---

## Testing

```bash
bash tests/run_tests.sh            # offline: routing + unit tests (no agy calls)
MMT_LIVE=1 bash tests/run_tests.sh # also run live agy smoke tests (network + agy)
```

---

## Known open items

- **P2 — quota error grounding:** `quota_patterns` in `roster.json` are sensible defaults;
  they haven't been validated against a real agy credit-exhaustion error yet. Harden
  `quota_patterns` / `quota_exit_codes` on the first real limit hit (see PROBES.md).
- **Hook scope:** the PreToolUse guard intentionally matches only `Read` for now (start
  narrow, widen on evidence). Bash-based dump/disasm interception is deferred.

## Env overrides

| Var | Purpose |
|---|---|
| `MMT_AGY_BIN` | explicit path to the agy binary |
| `MMT_CODEX_BIN` | explicit path to the codex binary (default: `codex` on PATH) |
| `MMT_PYTHON` | python interpreter to use |
| `MMT_ROSTER` | alternate roster.json |
| `MMT_TAGS` | alternate tags.txt |
| `MMT_STATE_DIR` / `MMT_STATE_FILE` | HUD state location |
| `MMT_STDIN_KEEPALIVE_SECS` | how long the open-stdin pipe is held (default 600) |
| `MMT_HOOK_DISABLE` / `MMT_HOOK_MAX_BYTES` / `MMT_HOOK_EXTS` | heavy-read hook tuning |
