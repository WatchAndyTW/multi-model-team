# multi-model-team — project guide for Claude

A Claude Code **plugin** that delegates token-heavy, self-contained tasks to a local
pre-authed **`agy`** (Gemini) CLI — choosing backend/model by task size and type, with
credit-exhaustion fallback to native Claude and a glanceable statusline HUD.

**Status:** built, adversarially reviewed, and green. `tests/run_tests.sh` passes 155/155 offline
(plus live agy + codex smoke tests under MMT_LIVE=1). Two live backends: **agy** (Gemini) and **codex** (OpenAI
Codex CLI); opencode remains a config-only stub. codex also serves as the **`/team` verifier**. See `README.md` (user-facing),
`PROBES.md` (grounded CLI findings), and `docs/PLAN.md` (original design plan).

---

## ⚠️ Backend invocation quirks

### agy (gemini) — needs a TTY

`agy` gates its output on `isatty(stdout)`. Run through a normal pipe (a hook, a subagent
shell, `bash run.sh`) it **exits 0 and prints nothing** — a silent no-op that looks like
success. Every invocation MUST therefore:

1. be wrapped in **winpty**: `winpty -Xallow-non-tty -Xplain <agy.exe> --print "<prompt>" …`
2. be given an **open, idle stdin** (a held-open `mkfifo` pipe) — agy emits nothing if stdin
   is already at EOF (`/dev/null` or a drained pipe).

Both are handled in `scripts/lib/backends.sh` (`_mmt_with_open_stdin`, `mmt_agy_invoke`).
The health check (`agy --version`) is the exception — it is NOT TTY-gated and must run
**without** winpty (winpty yields empty output for `--version`). Full detail in `PROBES.md`.

Real model names (exact `agy models` display strings): `Gemini 3.1 Pro (Low)` (standard),
`Gemini 3.5 Flash (Low)` (cheap). Binary auto-resolves from `$MMT_AGY_BIN` → PATH →
`$LOCALAPPDATA/agy/bin/agy.exe`.

### codex — no TTY needed

`codex` is invoked as `codex exec -s read-only --skip-git-repo-check --color never <prompt>`.
It is non-interactive: diagnostics go to stderr, the final response is printed to stdout, and
it exits cleanly — **no winpty, no open-stdin pipe needed** (contrast with agy/gemini above).
`_mmt_invoke_codex` + `_mmt_health_codex` in `backends.sh` handle dispatch; `kind:"codex"`,
`use_winpty:false`, `oneshot_flag:"exec"` in `config/roster.json`. The sandbox flag
(`-s read-only`) is baked into `extra`, so `run.sh` skips the generic `--sandbox` append
(codex sets `sandbox_flag:""`). The codex agent (`agents/codex.md`) is generated with
`dispatch:forced` — it always pins the codex backend directly.

---

## Architecture / data flow

```
task text
   │
   ▼  scripts/route.sh        pure decision, no model call
   │    ├─ scripts/lib/score.sh   char count + keyword type tags (config/tags.txt)
   │    └─ scripts/lib/match.py   first-match-wins over config/roster.json "routes" (json)
   ▼  decision JSON {backend, model, tier, rule, native}
   │
   ▼  scripts/run.sh          executor
        ├─ scripts/lib/config.py    roster.json → bash-sourceable MMT_BE_*/defaults (json, no jq)
        ├─ scripts/lib/backends.sh  backend resolve (by kind) + winpty invoke + clean() + quota
        ├─ scripts/lib/state.sh     HUD state → ~/.cache/mmt/state.json
        └─ on backend success: cleaned stdout;  else: MMT_NATIVE_HANDOFF sentinel
   │
   ▼  statusline/statusline.sh   fork-free HUD line (reads state.json)
```

`run.sh` walks a fallback chain = chosen backend + `quota_fallback` (deduped). `quota_fallback`
is now `["agy","codex","native:sonnet"]` — agy quota exhaustion falls through to codex, then
to native Claude as last resort (`MMT_NATIVE_HANDOFF` sentinel). The compact-return contract ("Return only the
result, no preamble.") is prepended to every delegated prompt — savings depend on a small
return crossing back to Claude.

---

## Directory map

```
.claude-plugin/plugin.json   manifest (auto-discovers commands/ agents/ hooks/hooks.json)
settings.json                reference statusLine (see HUD note below)
config/roster.json           ALL config (JSON): defaults + backends + agents + routes + proactive
config/tags.txt              task-type classifier — `<type> <ERE>` per line (stays a flat file)
scripts/route.sh             decision only
scripts/run.sh               executor + fallback chain + HUD state (one task)
scripts/team.sh              /team fan-out — run a plan's agy subtasks via run.sh in parallel
scripts/lib/{score.sh,match.py,config.py,backends.sh,state.sh,common.sh}
scripts/lib/{team_spec.py,team_plan.py}   cap-spec parser; plan.json -> per-subtask files
scripts/lib/gen_agents.py    regenerate agents/*.md from roster.json `agents` (enable/disable/role)
scripts/hooks/heavy-read-guard.sh   PreToolUse guard for oversized RE-dump reads
scripts/hooks/proactive-route.sh    UserPromptSubmit nudge: agy-routable prompt -> suggest delegating
scripts/hooks/spawn-route-guard.sh  PreToolUse Task|Agent guard: nudge/deny agent spawns that route to agy/codex (NOT-/team)
statusline/statusline.sh     fork-free HUD
agents/{delegate,av-research,bulk-summarizer}.md   GENERATED from roster.json (gen_agents.py)
commands/{team,route-test}.md    /team = multi-agent fan-out; /route-test = dry-run router
workflows/team.mjs           Ultracode dynamic-workflow fan-out (Workflow tool)
hooks/hooks.json             PreToolUse (Read guard + Task|Agent spawn guard) + UserPromptSubmit (proactive nudge)
tests/run_tests.sh           offline suite + opt-in live agy smoke (MMT_LIVE=1)
docs/PLAN.md                 original implementation plan (historical)
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
   signal (refactor/bugfix/integration) goes to Sonnet even if it also mentions a button/
   script/config. "When uncertain between agy and sonnet, prefer sonnet; never agy on a guess."
4. `code-review-test` (codex) sits BELOW judgment-coding (a refactor/bugfix word still wins → Sonnet)
   and BELOW the OPUS rules, but ABOVE the commodity agy rules — so PURE review/test/verify lands on
   codex, not agy. (The `integration` tag was tightened so "integration tests" → codex, not Sonnet.)
5. Unclassified → `catch-all-safe` → Sonnet.

**These invariants govern AUTO-ROUTING only — an explicit backend choice overrides the hard line.**
They are what `route.sh` picks when nothing is forced (raw `run.sh "<task>"`, the proactive nudge,
`/route-test`). When the orchestrator **explicitly** chooses a backend — a forced agent
(`dispatch:forced`: `delegate` / `av-research` / `bulk-summarizer` / `codex`), a
`run.sh --decision '{…,"native":false}'` call, or a `/team` subtask assignment — `run.sh` dispatches
to that backend **without consulting `route.sh`**, so the OPUS hard line never bounces an
explicitly-chosen job back to native. The plugin honors the choice; whether the backend itself
accepts the task (e.g. a CLI declining RE) is the backend's call, not a plugin rejection. The
generated forced-agent bodies reflect this — they run the dispatch as given and never self-reject on
content. (`route`-mode agents still defer to `route.sh` and its hard line.)

**Tuning needs no code edits:** edit `config/tags.txt` to change *what type* a task is, and
`config/roster.json` to change *where a type routes*. Verify with `/route-test`. When editing
the OPUS hard-line regexes, keep them tight — a bare word like `binary`/`hooks`/`injection`
will false-positive on "binary search" / React "hooks" / "dependency injection" and force
Opus. When editing agy regexes, keep them specific — bare `extract`/`config file` steal
refactor/judgment work. Add a regression test in `tests/run_tests.sh` for any routing change.

Presets (`[defaults].preset` or `--preset`): `budget` pushes borderline judgment-coding to
agy; `premium` pulls standard-coding up to Sonnet (keeps agy for its categorical edges).

---

## /team — multi-model team pipeline (v0.3)

`/team [N:gemini,M:claude] <task>` runs a task through a staged **plan → exec → verify → fix**
pipeline built for **our model dispatching**: **native, agy and codex are equal, configurable tools**
— the decomposer assigns each subtask to its best-fit backend, native Claude plans/synthesizes, and
any backend (default codex) verifies. The stages are
**decompose → dispatch (dependency-aware) → verify → fix (bounded) → synthesize**. Flow
(in `commands/team.md`):
1. parse the optional cap spec via `scripts/lib/team_spec.py` → `{gemini, claude}` (caps =
   max agents per backend; `gemini`=agy, `claude`=native; defaults 4/2; aliases + clamp).
2. Claude decomposes the task, then **writes a `plan.json`** (array of
   `{label, task, backend, tier, deps?, verify?}`) via the Write tool — task text stays inert
   data, never shell-parsed (injection-safe boundary; same reason `/route-test` uses stdin).
   `deps` = labels this subtask consumes (run after them, results handed in); `verify` = a
   one-line acceptance criterion. `team_plan.py` **ignores `deps`/`verify`** (they're inert),
   so the script path tolerates the richer schema without change.
3. Claude dispatches each subtask as its **own parallel `Task` sub-agent**, a dependency **wave** at
   a time — the whole wave spawned in ONE message (true parallel, OMC-style fan-out, **not** inline
   single-session). CLI subtasks (agy/codex) get a **faithful-relay** worker that runs
   `run.sh --decision {backend}` and returns the CLI's stdout verbatim (a bare `MMT_NATIVE_HANDOFF`
   → the lead spawns a **visible** native worker — same no-dress-up contract as `team.mjs`); native
   subtasks get a **solver** worker. Every worker prompt is tagged `[mmt-team-worker]` so the
   spawn-guard hook exempts it. (`scripts/team.sh --plan <file> --gemini-cap G` remains as a
   **scripted no-agents alternative** — parallel `run.sh` subprocesses, `--- AGY/CODEX/NATIVE
   [label] ---` blocks, addressing each subtask by **msys-form `$WORK/<idx>.task`**.)
4. The lead **verifies** every result against its criterion **by delegating the review to the
   configured verifier** (default codex; forced `backend:codex` via `run.sh`, rule `team-verify`;
   native judgment falls back if codex is unavailable), **fixes** failures in a bounded loop (default
   1 attempt; a bare `MMT_NATIVE_HANDOFF` counts as a fail → solve natively), then synthesizes.

**Ultracode path (the full implementation):** when the Workflow tool is available, `/team`
runs `workflows/team.mjs`, which does the entire pipeline deterministically: decompose agent
(emits `deps` + `verify`) → dependency-ordered **waves** (`parallel()` per wave; native agents
solve in-context, CLI agents go through the **faithful relay**, upstream results injected as
context) → per-result **verify** stage → **bounded fix** re-dispatch → synthesize.

**Faithful relay (the no-dress-up contract).** The Workflow runtime can't shell out itself, so a
non-native backend is reached by spawning a sub-agent (it has Bash) to run `run.sh`. That sub-agent
(`dispatchRelay`) is a **PURE PIPE**: forced into a `{stdout, backend_ran}` schema, forbidden from
solving/analyzing the payload — it just runs the one command and reports the verbatim stdout plus
whether the CLI actually produced output. **The fallback decision lives in deterministic code, not in
the agent:** if `backend_ran` is false (CLI unavailable / `MMT_NATIVE_HANDOFF` / empty), `dispatch()`
re-dispatches the subtask to a **VISIBLE `native:<label>-fallback` agent** — Claude never does the work
behind a `gemini:`/`codex:` label. Each result record carries **`ranOn`** = the backend that *actually*
produced it (`agy`/`codex`/`native`, or `native-fallback(<cli>)`), and fallbacks are logged + counted
(`counts.nativeFallbacks`). This is the fix for the bug where a relay told to "solve it yourself on
handoff" silently turned a Gemini subtask into a Claude one. **Verify** uses the same pipe: it drives
the configured `verifier` CLI through `dispatchRelay` (rule `team-verify`) and parses its `PASS/FAIL`
verdict **deterministically** (`parseVerdict`) — no Claude agent re-judges the CLI's output; if that CLI
is unavailable it falls back to a visible `native:verify:` agent. `verifier:'native'` skips the relay
and judges on Claude directly.

Args: `{task, caps, pluginRoot, verify?=true, verifier?='codex', maxFixLoops?=1 (max 3)}`. Returns
`{plan, backends, caps, verifier, counts:{byBackend,ranOn,verified,failed,nativeFallbacks}, results, final}`.
Agent labels are backend-prefixed in the progress tree — `gemini:<label>` (agy relay pipe),
`codex:verify:<label>` (codex review pipe), `native:`/`native:verify:`/`native:<label>-fallback`
(Claude) — and each subtask's tier maps to a concrete model via `tierModel` (`sonnet` default, `opus`
only when the decompose marks it genuinely hard), so the native model is **dynamic by complexity**, not
the inherited Opus main-loop model (the old behavior: `dispatchNative` set no model → every native
subtask ran on Opus regardless of tier). Determinism-safe (no Date/random APIs — they break Workflow
resume) and tolerates `args` as object **or** JSON string.

## Proactive delegation hooks (opt-in)

Two nudges, both gated by `[proactive].enabled = true` in `roster.json` (off by default):

**(1) Prompt nudge — `scripts/hooks/proactive-route.sh` (UserPromptSubmit).** Runs each submitted
prompt through `route.sh`; if it routes to agy, injects a one-shot reminder
(`hookSpecificOutput.additionalContext`) nudging Claude to delegate via the
`multi-model-team:delegate` agent / `/team` instead of solving inline. Never fires for slash commands
or prompts that route to native (judgment/RE/systems).

**(2) Spawn guard — `scripts/hooks/spawn-route-guard.sh` (PreToolUse, matcher `Task|Agent`).** The
"NOT /team" enforcer the user asked for: when you spawn an agent **outside** the team pipeline and its
task routes to a CLI backend (agy or codex), it makes the work actually run on that CLI.
`enforce_spawns=false` (default) → a **non-blocking nudge** (`permissionDecision:"allow"` +
`additionalContext`) to dispatch via `run.sh` / the matching plugin agent; `enforce_spawns=true` → a
hard **`permissionDecision:"deny"`** with the same instruction, forcing a re-dispatch. **Exempt:** our
own subagents (`subagent_type` `multi-model-team:*`) and the plugin's `/team` workers (relay workers
carry `run.sh`/`--decision`; native workers are tagged `[mmt-team-worker]`). `guard_spawns=false`
disables just this guard. native-routing spawns are left untouched (correctly a Claude agent).

**Both:** deterministic firing, soft compliance in nudge mode. Config in `[proactive]` (`enabled`,
`max_chars`, `min_chars`, `rules` CSV allowlist, `guard_spawns`, `enforce_spawns`); `config.py
proactive-env` emits these as `MMT_PROACTIVE_*`. **Cost discipline:** when disabled (the default) both
hooks bail via a pure-bash `[proactive].enabled` pre-check **before spawning any python** — so they
cost ~nothing until opted in. Hard kill switch: `MMT_PROACTIVE_DISABLE=1`. Injection-safe: the
prompt/spawned-task reaches `route.sh` only on stdin, never as an argument, and is never echoed back
into the reminder. Tests: `── Unit: proactive hook` and `── Unit: spawn-route guard` in
`tests/run_tests.sh`.

## Config = one JSON file (`config/roster.json`)

All config is JSON (hard cut from TOML). Six top-level sections (`_comment`/`_about`/`_note`
keys are inline docs the parsers ignore):

- **`defaults`** — `preset`, `fallback`, `quota_fallback` (ordered backend chain).
- **`backends`** — each key is a backend a route can target. `enabled` gates use; `kind` selects
  the invoker in `backends.sh`. **`kind:"gemini"` (agy) and `kind:"codex"` both have live
  invokers**; `opencode` is the only `enabled:false` stub remaining — enabling it without an
  invoker just health-fails and falls through to the next hop. Adding a future backend = add
  `_mmt_invoke_<kind>` + `_mmt_health_<kind>` + dispatch case in `mmt_be_invoke`/`mmt_be_health`
  and flip `enabled`; no other code changes.
- **`agents`** — each delegation subagent: `enabled`, `backend`, `tier`, `dispatch`
  (`route`=let the router decide; `forced`=pin backend+tier), `model`, `color`, `role`. The
  `.md` files in `agents/` are **generated** from this by `scripts/lib/gen_agents.py` — edit the
  JSON then run it; `enabled:false` deletes the agent's `.md` so Claude Code stops surfacing it.
- **`routes`** — first-match-wins rules (was `[[route]]`); `match.py` skips the array's `_comment`
  marker objects. Route invariants (Opus hard-line first, multimodal before judgment-coding,
  judgment-coding above the commodity agy rules) are unchanged — just JSON now.
- **`proactive`** — the UserPromptSubmit nudge config.
- **`team`** — the `/team` pipeline roles + defaults, emitted as JSON by `config.py team-config` and
  passed into `team.mjs` via `args.teamConfig` (the Workflow runtime can't read files itself). **native,
  agy and codex are EQUAL** — any can be assigned any subtask, any can verify: `dispatch_backends` (the
  eligible set the decomposer picks from), `verifier` (default codex; `"native"`=Claude), `caps`
  (per-backend), `tier_models` (tier→model), `verify`, `max_fix_loops`, `relay_model`. Nothing is
  hardcoded — precedence is built-in default < `team` < per-invocation arg.

**Parser contract:** `config.py <roster.json> {defaults-env|backend-env <name>|proactive-env}`
emits bash-sourceable vars. `run.sh` loads `defaults-env` once, then `backend-env <name>` per
fallback hop; `backends.sh` reads `MMT_BE_*` and dispatches on `MMT_BE_KIND`. A disabled/unknown
backend yields `MMT_BE_ENABLED=0` → run.sh skips it.

## Conventions & constraints (Windows / msys)

- **No `jq`.** statusline parses state.json with a fork-free pure-bash loop (state.json is
  always one-field-per-line). `python3` (stdlib `json`, any version) parses `roster.json` in
  route/run/hooks; the proactive hook's `enabled` pre-check reads JSON in pure bash (`$(<file)`
  + substring) so it forks nothing when off. (Config is JSON now — `tomllib` is no longer used.)
- **Native python can't open embedded msys paths.** Pass file paths as separate args (MSYS2
  converts those) or pipe content via stdin; never embed `/tmp/...` inside a python `-c` string.
- **No `grep` in hot/looping paths.** msys grep can core-dump under rapid forking; quota
  detection is pure-bash substring matching.
- **Untrusted task text is injection-unsafe in slash commands.** Claude Code textually pastes
  `$ARGUMENTS` into `` !`bash` `` blocks (RCE). `/team` and `/route-test` therefore do NOT
  inline-exec — they instruct Claude to run the script via the Bash tool, feeding the task on
  stdin via a single-quoted heredoc. Keep it that way.
- **HUD registration is manual.** A plugin's bundled `settings.json` does not register a
  top-level `statusLine` (only `agent`/`subagentStatusLine`); the user adds the statusLine to
  their own `~/.claude/settings.json` with an absolute path. `settings.json` here is a reference.
- Scripts self-locate via `BASH_SOURCE`; agents/commands reference `${CLAUDE_PLUGIN_ROOT}`.

---

## Testing

```bash
bash tests/run_tests.sh             # offline: routing + unit tests (no agy calls)
MMT_LIVE=1 bash tests/run_tests.sh  # + live agy smoke tests (network + agy)
```
Keep the suite green. Add cases for any routing or behavior change.

---

## Open items

- **P2 — quota grounding:** `quota_patterns` in `roster.json` are unvalidated defaults;
  harden `quota_patterns`/`quota_exit_codes` on the first real agy credit-exhaustion error.
- **Backends:** opencode is config-only (stub, `enabled:false`); codex is live. Health-gate
  ensures an unavailable CLI falls through to the next fallback hop. Hook is intentionally
  `Read`-only for now (widen on evidence).
