# multi-model-team — project guide for Claude

A Claude Code **plugin** that delegates token-heavy, self-contained tasks to local
pre-authed CLI backends — **`agy`** (Gemini) and **`codex`** (OpenAI Codex CLI) — choosing
backend/model by task size and type, with credit-exhaustion fallback to native Claude and a
glanceable statusline HUD.

**Stack:** Node ESM (`.mjs`), zero-build, Node >=18. **One native runtime dependency: `node-pty`**
(the agy lane runs under a real pseudo-terminal — ConPTY on Windows, forkpty on POSIX); everything
else is Node stdlib. Cross-platform (Windows/Linux/macOS). `package.json` `"type":"module"`.

**Status:** built, adversarially reviewed, and green. `npm test` passes **93/93** offline
(plus live agy + codex smoke tests under `MMT_LIVE=1`). Two live backends: **agy** (Gemini)
and **codex** (OpenAI Codex CLI); opencode remains a config-only stub. codex also serves as the
**`/team` verifier**. See `README.md` (user-facing), `PROBES.md` (grounded CLI findings), and
`docs/PLAN.md` (original design plan).

**Why the Node ESM rewrite?** The bash hooks forked ~6–7 processes per invocation under a 10 s
msys timeout and were intermittently killed ("hooks not triggering sometimes"). Each hook is now
**one fork-free Node process** (in-process routing via `hook-common.mjs`); the fragile
substring proactive-gate is replaced by real `JSON.parse`. The dead `Workflow` PreToolUse guard
was dropped (empirically never fired — Claude Code doesn't dispatch `PreToolUse` to a `Workflow`
matcher).

---

## ⚠️ Backend invocation quirks

### agy (Gemini) — needs a TTY → runs under node-pty

`agy` gates its output on `isatty(stdout)`. Run through a normal pipe it **exits 0 and prints
nothing** — a silent no-op that looks like success. The plugin therefore runs agy under a real
**pseudo-terminal via `node-pty`** (`backends.mjs runPty`): ConPTY on Windows 10/11, forkpty on
Linux/macOS. `isatty(stdout)` is true, so agy emits — **with no visible console window, working even
from a fully headless parent** (a Bash-tool subshell, a hook, a `/team` or `/reasoning` sub-agent).
The prompt rides as a real **argv element** (node-pty passes argv to the child, never via a shell —
injection-safe). A pty is one merged stream (stdout+stderr); `clean()` strips the terminal control
bytes (CSI/OSC) ConPTY emits. `node-pty` is **lazy-imported** so the rest of `backends.mjs`
(codex/health/clean/quota) still loads if the native module is absent — only the agy lane needs it.

The health check (`agy --version`) is NOT TTY-gated and runs via a plain `runChild` (no pty needed).

**History:** earlier versions wrapped agy in **winpty** and held an idle stdin open (the bash FIFO
replacement). winpty needs a real Windows console, which a headless parent can't provide
(`winpty.cc:924` `cols>0 && rows>0` assertion) — so agy was a silent no-op outside a real terminal
and fell through to codex/native. node-pty (ConPTY) removes that constraint entirely; `ptyWrap`
(winpty/script) in `platform.mjs` is retained but no longer on the agy path. Full detail in `PROBES.md`.

Real model names (exact `agy models` display strings): `Gemini 3.1 Pro (Low)` (standard),
`Gemini 3.5 Flash (Low)` (cheap). Binary auto-resolves via `platform.resolveBinary`: `$MMT_AGY_BIN`
→ PATH scan → default candidates (`$LOCALAPPDATA/agy/bin/agy.exe` on Windows;
`~/.local/bin/agy`, `/usr/local/bin/agy`, `/usr/bin/agy` on Linux; same + `/opt/homebrew/bin/agy`
on macOS).

### codex — no TTY needed

`codex` is invoked with the prompt delivered **via stdin** (`codex exec … -` reads from stdin),
not as a command-line argument. This fixes a real Windows bug where the npm `.cmd` shim spawned
via `cmd.exe` truncated a multi-line prompt at the first newline. `platform.resolveBinary` prefers
a PATHEXT match (`codex.cmd`) over the extensionless npm shim, and `.cmd`/`.bat` wrappers are
spawned via `cmd.exe /d /s /c`. No winpty, no open-stdin keepalive needed.

---

## Architecture / data flow

```
task text (stdin — injection-safe boundary)
   │
   ▼  src/bin/route.mjs          pure decision, no model call
   │    ├─ src/lib/score.mjs     char count + keyword type tags (config/tags.txt)
   │    └─ src/lib/router.mjs    first-match-wins over config/roster.json "routes"
   ▼  decision JSON {backend, model, tier, rule, native, preset, score}
   │
   ▼  src/bin/run.mjs            executor
        ├─ src/lib/config.mjs    roster.json → plain JS objects (no bash eval, real JSON.parse)
        ├─ src/lib/backends.mjs  backend invoke (by kind: gemini/codex) + clean() + quota
        ├─ src/lib/platform.mjs  ptyWrap (winpty/script), resolveBinary, stateDir
        ├─ src/lib/state.mjs     HUD state → stateDir()/state.json
        └─ on backend success: cleaned stdout;  else: MMT_NATIVE_HANDOFF sentinel
   │
   ▼  statusline/statusline.mjs  fork-free HUD line (reads state.json)
```

`run.mjs` walks a fallback chain = chosen backend + `quota_fallback` (deduped). Default:
`["agy","codex","native:sonnet"]` — agy quota exhaustion falls through to codex, then to native
Claude (`MMT_NATIVE_HANDOFF` sentinel). When a backend fails (non-zero or empty output), `run.mjs`
captures stderr into `last error` and carries it into the handoff `reason=` — so the cause is
visible instead of a silent empty result.

---

## Directory map

```
.claude-plugin/plugin.json      manifest (auto-discovers commands/ agents/ hooks/hooks.json)
settings.json                   reference statusLine (see README HUD note)
config/roster.json              ALL config: defaults + backends + agents + routes + proactive + team + reasoning
config/tags.txt                 task-type classifier — `<type> <ERE>` per line (stays a flat file)
src/lib/platform.mjs            cross-platform OS layer: PTY wrap, binary resolve, state dir (NEW)
src/lib/config.mjs              roster.json loader → plain JS objects (replaces config.py)
src/lib/score.mjs               char count + keyword type classification (replaces score.sh)
src/lib/router.mjs              first-match-wins decision engine (replaces match.py)
src/lib/backends.mjs            agy/codex invokers + clean() + quota (replaces backends.sh)
src/lib/state.mjs               HUD state read/write (replaces state.sh)
src/lib/hook-common.mjs         shared hook runtime — one fork-free node process (NEW; reliability core)
src/lib/team-spec.mjs           /team cap-spec parser (replaces team_spec.py)
src/lib/team-plan.mjs           plan.json → per-subtask files (replaces team_plan.py)
src/lib/reason-spec.mjs         /reasoning panel-spec parser: expandPanel / parsePanel / splitPanel
src/lib/gen-agents.mjs          regenerate agents/*.md from roster.json (replaces gen_agents.py)
src/bin/route.mjs               task → decision JSON CLI (replaces route.sh)
src/bin/run.mjs                 executor + fallback chain + HUD state (replaces run.sh)
src/bin/team.mjs                scripted CLI-backend fan-out (replaces team.sh)
src/bin/reason.mjs              scripted panel fan-out engine for /reasoning (no-agents path)
src/bin/setup.mjs               /mmt-setup engine: create/reset ~/.claude/mmt-roster.json
hooks/proactive-route.mjs       UserPromptSubmit nudge: CLI-routable prompt → suggest delegating
hooks/spawn-route-guard.mjs     PreToolUse(Task|Agent) guard: nudge/deny CLI-routable agent spawns
hooks/command-fanout-guard.mjs  UserPromptSubmit guard: force /reasoning and /team into the engine
hooks/hooks.json                hook registrations (all commands: `node "${CLAUDE_PLUGIN_ROOT}/hooks/<x>.mjs"`)
statusline/statusline.mjs       fork-free HUD (replaces statusline.sh)
agents/{agy,codex}.md   GENERATED from roster.json (gen-agents.mjs)
commands/{team,route-test,reasoning,mmt-setup}.md   /team = multi-agent fan-out; /route-test = dry-run router; /reasoning = Fusion pipeline; /mmt-setup = durable personal roster setup
workflows/team.mjs              Ultracode dynamic-workflow fan-out (Workflow tool)
workflows/reasoning.mjs         Ultracode Fusion workflow: Panel → Judge → Synthesize
test/*.test.mjs                 offline test suite (npm test — node --test)
docs/PLAN.md                    original implementation plan (historical)
docs/REASONING.md               design contract for the /reasoning Fusion pipeline
```

---

## Routing model (the contract — don't regress it)

Four lanes (agy / codex / Sonnet / Opus), by "if the model gets this subtly wrong, would I notice immediately?":

| → **agy** (commodity, verifiable) | → **Sonnet** (judgment) | → **Opus** (hard line) |
|---|---|---|
| new components, CSS, UI, SVG/anim | refactor *existing* code | RE, IL2CPP, protobuf-RE |
| scaffold, CRUD, REST, scripts, CLI | integration, bugfix root-cause | disasm, decompile, VMProtect |
| SQL, regex, configs, Dockerfiles | API/data-model *design* | DLL injection, Detours/MinHook |
| fixtures, data transforms, codegen | production logic, edge cases | FFI, unsafe, shellcode, kernel |
| web research, doc summary, bulk | unclassified / uncertain | concurrency, lock-free, KCP, proc-macro |
| video/audio (Claude can't anyway) | | (size-irrelevant — always Opus) |

**→ codex** (code-specialized, between agy-Standard and native-Sonnet): **code review** (review a
diff/PR), **test-writing** (unit / integration / e2e / regression suites), and **verification** (does
it meet the spec). Pure review/test/verify lands here; a judgment word above still wins → Sonnet.

**Invariants enforced by rule ORDER in `roster.json` (first match wins):**
1. OPUS hard-line rules sit first — RE/injection/systems-hard can never fall through to agy.
2. `multimodal` (Gemini-exclusive) is the first agy rule — A/V must go to agy even if it
   also carries a judgment word.
3. `judgment-coding` is ordered ABOVE the commodity agy rules — a task with a judgment
   signal (refactor/bugfix/integration) goes to Sonnet even if it also mentions a button/script/
   config. "When uncertain between agy and sonnet, prefer sonnet; never agy on a guess."
4. `code-review-test` (codex) sits BELOW judgment-coding (a refactor/bugfix word still wins →
   Sonnet) and BELOW the OPUS rules, but ABOVE the commodity agy rules — so PURE review/test/
   verify lands on codex, not agy.
5. Unclassified → `catch-all-safe` → Sonnet.

**These invariants govern AUTO-ROUTING only — an explicit backend choice overrides the hard line.**
They are what `route.mjs` picks when nothing is forced. When the orchestrator **explicitly**
chooses a backend — a forced agent (`dispatch:forced`), a `run.mjs --decision '{…,"native":false}'`
call, or a `/team` subtask assignment — `run.mjs` dispatches to that backend **without consulting
the router**, so the OPUS hard line never bounces an explicitly-chosen job back to native.

**Tuning needs no code edits:** edit `config/tags.txt` to change *what type* a task is, and
`config/roster.json` to change *where a type routes*. Verify with `/route-test`. When editing
the OPUS hard-line regexes, keep them tight — a bare word like `binary`/`hooks`/`injection`
will false-positive on "binary search" / React "hooks" / "dependency injection" and force Opus.
When editing agy regexes, keep them specific — bare `extract`/`config file` steal
refactor/judgment work. Add a regression test in `test/*.test.mjs` for any routing change.

Presets (`[defaults].preset` or `--preset`): `budget` pushes borderline judgment-coding to
agy; `premium` pulls standard-coding up to Sonnet (keeps agy for its categorical edges).

---

## /team — multi-model team pipeline (v0.3)

`/team [N:gemini,M:claude] <task>` runs a task through a staged **plan → exec → verify → fix**
pipeline: **native, agy and codex are equal, configurable tools** — the decomposer assigns each
subtask to its best-fit backend, native Claude plans/synthesizes, and any backend (default codex)
verifies. Stages: **decompose → dispatch (dependency-aware) → verify → fix (bounded) → synthesize**.
Flow (in `commands/team.md`):

1. Parse the optional cap spec via `src/lib/team-spec.mjs` → `{gemini, claude}` (caps = max
   agents per backend; `gemini`=agy, `claude`=native; defaults 4/2; aliases + clamp).
2. Claude decomposes the task, then **writes `.mmt/plans/plan.json`** (array of
   `{label, task, backend, tier, deps?, verify?}`) via the Write tool — `.mmt/` is this plugin's
   state dir (NOT `.omc/`, even under OMC) — task text stays inert
   data, never shell-parsed (injection-safe boundary; same reason `/route-test` uses stdin).
   `deps` = labels this subtask consumes; `verify` = a one-line acceptance criterion.
   `src/lib/team-plan.mjs` **ignores `deps`/`verify`** (inert in the scripted path).
3. Claude dispatches each subtask as its **own parallel `Task` sub-agent**, a dependency **wave**
   at a time — the whole wave spawned in ONE message (OMC-style fan-out). CLI subtasks get a
   **faithful-relay** worker that runs `node src/bin/run.mjs --decision {backend}` and returns the
   CLI's stdout verbatim (a bare `MMT_NATIVE_HANDOFF` → lead spawns a visible native worker).
   Every worker prompt is tagged `[mmt-team-worker]` so the spawn-guard hook exempts it.
   (`src/bin/team.mjs --plan <file> --gemini-cap G` remains as a **scripted no-agents alternative**
   — parallel `run.mjs` subprocesses, `--- AGY/CODEX/NATIVE [label] ---` blocks.)
4. The lead **verifies** every result against its criterion via the configured verifier (default
   codex; forced `backend:codex` via `run.mjs`, rule `team-verify`; native judgment falls back if
   codex is unavailable), **fixes** failures in a bounded loop (default 1 attempt), then synthesizes.

**Ultracode path:** when the Workflow tool is available, `/team` runs `workflows/team.mjs`, which
does the entire pipeline deterministically: decompose → dependency-ordered waves → verify →
bounded fix re-dispatch → synthesize. The faithful relay (`dispatchRelay`) is a PURE PIPE:
forced into `{stdout, backend_ran}` schema, forbidden from solving/analyzing the payload. Each
result carries `ranOn` = the backend that *actually* produced it. `verifier:'native'` skips the
relay and judges on Claude directly.

Args: `{task, caps, pluginRoot, verify?=true, verifier?='codex', maxFixLoops?=1 (max 3)}`. Returns
`{plan, backends, caps, verifier, counts:{byBackend,ranOn,verified,failed,nativeFallbacks}, results, final}`.
Agent labels are backend-prefixed — `gemini:<label>`, `codex:verify:<label>`, `native:` etc.
Native subtask model is **dynamic by complexity** (`sonnet` default, `opus` only when genuinely
hard). Determinism-safe (no Date/random APIs) and tolerates `args` as object **or** JSON string.

## /reasoning — multi-model parallel reasoning (Fusion)

`/reasoning [panel-spec] <question>` fans the **same question** out to a **panel** of models in
parallel, has a **judge** compare their answers into structured analysis, then produces one unified
answer that is better than any single model's. Maps OpenRouter's Fusion pipeline onto this
plugin's backends.

**Pipeline:** Panel → Judge → Synthesize.

1. **Panel** — every panelist (a `{backend, tier}` pair) answers the question independently and
   simultaneously. Native panelists run as real sub-agents pinned to their model; CLI panelists
   go through the faithful `run.mjs` relay (`rule:"reason"`). A CLI unavailable → visible native
   fallback agent (never a silent Claude substitution; `ranOn` tracks the actual backend).
2. **Judge** — one agent (default Opus) compares all panel answers into structured analysis:
   `consensus` (high-confidence, most agreed), `contradictions`, `unique_insights` (one panelist
   only), `blind_spots` (angles none addressed).
3. **Synthesize** — one agent (default Opus) writes the single best unified answer: prefers
   consensus, folds in unique insights, resolves contradictions, addresses blind spots.

**Panel spec** (optional leading arg): comma-separated tokens like `2:gemini,opus,codex`. Token
vocabulary and alias map: see `docs/REASONING.md`. Default panel: `["opus","sonnet","gemini"]`.

**Two engines** — same as `/team`:
- **Ultracode path:** `workflows/reasoning.mjs` runs the full pipeline deterministically
  (`parallel()` for the Panel phase, schema-validated Judge, Synthesize). Preferred.
- **Fallback path:** parallel `Task` sub-agents for the Panel (tagged `[mmt-team-worker]`), then
  native judge + synthesize. Scripted alternative: `src/bin/reason.mjs` (no agents, stdin question).

Config lives in `roster.json` `reasoning` section (panel, judge, synthesizer, cap, tier_models,
relay_model); full token vocabulary and override precedence documented in `docs/REASONING.md`.

## Proactive delegation hooks (opt-in)

Two nudges (was three — the `Workflow` guard is dropped; it empirically never fired), all gated by
`[proactive].enabled = true` in `roster.json` (off by default):

**(1) Prompt nudge — `hooks/proactive-route.mjs` (UserPromptSubmit).** Runs each submitted prompt
through the router **in-process** (no fork); if it routes to a CLI backend, injects a one-shot
reminder (`hookSpecificOutput.additionalContext`) nudging Claude to delegate via the
`multi-model-team:agy` agent / `/team` instead of solving inline. Never fires for slash
commands or prompts that route to native (judgment/RE/systems).

**(2) Spawn guard — `hooks/spawn-route-guard.mjs` (PreToolUse, matcher `Task|Agent`).** The
"NOT /team" enforcer: when you spawn an agent **outside** the team pipeline and its task routes
to a CLI backend (agy or codex), the guard makes the work actually run on that CLI.
`enforce_spawns=false` (default) → a **non-blocking nudge**; `enforce_spawns=true` → a hard
**`permissionDecision:"deny"`**, forcing a re-dispatch. **Exempt:** our own subagents
(`subagent_type` `multi-model-team:*`) and `/team` workers (tagged `[mmt-team-worker]`).
**OMC-aware:** an OMC team worker (`tool_input.team_name` set, an `oh-my-claudecode:*` subagent,
or the OMC worker preamble) is **always nudged, never denied** — even under `enforce_spawns` — so
the guard can't stall OMC's persistent-teammate orchestration. Its `additionalContext` tells that
worker to execute its task via `node <root>/src/bin/run.mjs` and report back through OMC's
TaskList/SendMessage flow.

**Both hooks:** one fork-free node process each. Gate check uses real `JSON.parse` (no substring
scan). **Cost discipline:** when disabled both exit immediately (no forks) — zero cost. Hard kill
switch: `MMT_PROACTIVE_DISABLE=1`. Injection-safe: the prompt/spawned-task reaches the router only
in-memory, never as a shell argument. Tests: `── Unit: proactive hook` and
`── Unit: spawn-route guard` in `test/*.test.mjs`.

## Config = one JSON file (`config/roster.json`)

All config is JSON. Six top-level sections (`_comment`/`_about`/`_note` keys are inline docs
the parsers ignore):

- **`defaults`** — `preset`, `fallback`, `quota_fallback` (ordered backend chain).
- **`backends`** — each key is a backend a route can target. `enabled` gates use; `kind` selects
  the invoker in `src/lib/backends.mjs`. **`kind:"gemini"` (agy) and `kind:"codex"` both have live
  invokers**; `opencode` is the only `enabled:false` stub remaining. Adding a future backend =
  add `invoke`/`health` dispatch cases in `backends.mjs` and flip `enabled`; no other code changes.
- **`agents`** — each delegation subagent: `enabled`, `backend`, `tier`, `dispatch`
  (`route`=let the router decide; `forced`=pin backend+tier), `model`, `color`, `role`. The
  `.md` files in `agents/` are **generated** from this by `src/lib/gen-agents.mjs` — edit the
  JSON then run `node src/lib/gen-agents.mjs`; `enabled:false` deletes the agent's `.md`.
- **`routes`** — first-match-wins rules; `src/lib/router.mjs` skips `_comment` marker objects.
  Route invariants (Opus hard-line first, multimodal before judgment-coding, judgment-coding above
  commodity agy rules) are unchanged.
- **`proactive`** — the UserPromptSubmit nudge config.
- **`team`** — the `/team` pipeline roles + defaults, read by `src/lib/config.mjs teamConfig()`
  and passed into `team.mjs` via `args.teamConfig`. **native, agy and codex are EQUAL** — any can
  be assigned any subtask, any can verify: `dispatch_backends`, `verifier`, `caps`, `tier_models`,
  `verify`, `max_fix_loops`, `relay_model`. Precedence: built-in default < `team` < invocation arg.

**Module contract:** `src/lib/config.mjs` exports `loadRoster`, `defaults`, `backend`, `agents`,
`routes`, `proactive`, `teamConfig` — plain JS objects, real `JSON.parse`, no bash eval, no
substring gating. `run.mjs` calls `config.defaults()` once, then `config.backend(name)` per
fallback hop.

## Conventions & constraints

- **One native dep (`node-pty`), Node stdlib otherwise.** The agy lane needs a real pseudo-terminal
  (ConPTY/forkpty) so its `isatty` gate emits; that's `node-pty`, loaded lazily in `backends.mjs`
  (`loadPty`) so only the agy path requires it. node-pty is **required on Windows** (ConPTY — winpty
  can't allocate a console headlessly) but **optional on POSIX**: when it's absent there, the agy lane
  falls back to the dep-free system **`script`** pty wrapper (`platform.ptyWrap`), so Linux/macOS need
  no native module. Resolution is **local-first, then global**: a plain
  `require` finds a plugin-local install, else `ensureGlobalNodeModules` prepends `npm root -g` to
  `NODE_PATH` + `Module._initPaths()` so a `npm install -g node-pty` resolves (require, not ESM
  import, because NODE_PATH only affects CJS resolution — the oh-my-claudecode native-dep trick). If
  neither resolves, agy degrades to the codex/native fallback with an install hint. No other runtime
  deps: no `jq`, no `python3`, no `grep` in hot paths. `state.mjs` writes flat one-field-per-line
  JSON so `statusline.mjs` can parse it without a real JSON parser (fork-free).
- **Untrusted task text is injection-unsafe in slash commands.** Claude Code textually pastes
  `$ARGUMENTS` into `!` bash blocks (RCE). `/team` and `/route-test` do NOT inline-exec — they
  instruct Claude to run the binary via the Bash tool, feeding the task on stdin. Keep it that way.
- **HUD registration is manual.** A plugin's bundled `settings.json` does not register a
  top-level `statusLine`; the user adds the `statusLine` to their own `~/.claude/settings.json`
  with an absolute path pointing to `statusline/statusline.mjs`. `settings.json` here is a reference.
- **Binary self-location.** `src/bin/*.mjs` and `hooks/*.mjs` resolve sibling files via
  `import.meta.url` (Node ESM); agents/commands reference `${CLAUDE_PLUGIN_ROOT}`.
- **Cross-platform:** `src/lib/platform.mjs` is the only place OS branching for PTY/binary/state
  belongs. Developed on Windows and **tested on Linux/macOS** — the POSIX paths (the `script` PTY
  shim, XDG state dir, POSIX binary candidates) are exercised on a real POSIX box.

---

## Testing

```bash
npm test                         # offline: 93/93 routing + unit tests (no backend calls)
MMT_LIVE=1 npm test              # + live agy + codex smoke tests (network required)
```

Keep the suite green. Add cases for any routing or behavior change. Tests live in `test/*.test.mjs`
and run with `node --test`.

---

## Open items

- **P2 — quota grounding:** `quota_patterns` in `roster.json` are unvalidated defaults. The
  detector is now **failure-gated** (`backends.quotaFromResult`): a successful call (exit 0 +
  non-empty output) is never treated as exhaustion, so a backend answer that merely *quotes* a
  pattern word (e.g. codex reading this repo's `quota_patterns`) is no longer discarded. Real
  exhaustion still relies on the heuristic patterns + `quota_exit_codes` — harden those on the
  first real agy/codex credit-exhaustion error.
- **Backends:** opencode is config-only (stub, `enabled:false`); codex is live. Health-gate
  ensures an unavailable CLI falls through to the next fallback hop.
- **Linux/macOS:** POSIX PTY shim (`script`) and XDG state dir in `platform.mjs` are exercised and
  tested on a real POSIX box.
