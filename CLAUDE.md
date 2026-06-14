# multi-model-team — project guide for Claude

A Claude Code **plugin** that delegates token-heavy, self-contained tasks to a local
pre-authed **`agy`** (Gemini) CLI — choosing backend/model by task size and type, with
credit-exhaustion fallback to native Claude and a glanceable statusline HUD.

**Status:** built, adversarially reviewed, and green. `tests/run_tests.sh` passes 48/48
(incl. live agy smoke tests). agy-only backend for now; codex/opencode are config-only
future additions. See `README.md` (user-facing), `PROBES.md` (grounded CLI findings), and
`docs/PLAN.md` (original design plan).

---

## ⚠️ The one thing that will bite you: agy needs a TTY

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

`run.sh` walks a fallback chain = chosen backend + `quota_fallback` (deduped). agy quota
exhaustion or failure falls through to the next backend, ultimately a `MMT_NATIVE_HANDOFF`
sentinel telling Claude to solve in-context. The compact-return contract ("Return only the
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
statusline/statusline.sh     fork-free HUD
agents/{delegate,av-research,bulk-summarizer}.md   GENERATED from roster.json (gen_agents.py)
commands/{team,route-test}.md    /team = multi-agent fan-out; /route-test = dry-run router
workflows/team.mjs           Ultracode dynamic-workflow fan-out (Workflow tool)
hooks/hooks.json             PreToolUse (Read guard) + UserPromptSubmit (proactive nudge)
tests/run_tests.sh           offline suite + opt-in live agy smoke (MMT_LIVE=1)
docs/PLAN.md                 original implementation plan (historical)
```

---

## Routing model (the contract — don't regress it)

Three buckets, by "if Gemini gets this subtly wrong, would I notice immediately?":

| → **agy** (commodity, verifiable) | → **Sonnet** (judgment) | → **Opus** (hard line) |
|---|---|---|
| new components, CSS, UI, SVG/anim | refactor *existing* code | RE, IL2CPP, protobuf-RE |
| scaffold, CRUD, REST, scripts, CLI | integration, bugfix root-cause | disasm, decompile, VMProtect |
| SQL, regex, configs, Dockerfiles | API/data-model *design* | DLL injection, Detours/MinHook |
| unit tests, fixtures, transforms | production logic, edge cases | FFI, unsafe, shellcode, kernel |
| web research, doc summary, bulk | unclassified / uncertain | concurrency, lock-free, KCP, proc-macro |
| video/audio (Claude can't anyway) | | (size-irrelevant — always Opus) |

**Invariants enforced by rule ORDER in `roster.json` (first match wins):**
1. OPUS hard-line rules sit first — RE/injection/systems-hard can never fall through to agy.
2. `multimodal` (Gemini-exclusive) is the first agy rule — A/V must go to agy even if it
   also carries a judgment word.
3. `judgment-coding` is ordered ABOVE the commodity agy rules — a task with a judgment
   signal (refactor/bugfix/integration) goes to Sonnet even if it also mentions a button/
   script/config. "When uncertain between agy and sonnet, prefer sonnet; never agy on a guess."
4. Unclassified → `catch-all-safe` → Sonnet.

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
pipeline built for **our model dispatching**: the "provider per role" is the
**agy (Gemini)** vs **native (Claude)** backend split, chosen per subtask. The stages are
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
3. `scripts/team.sh --plan <file> --gemini-cap G` runs the `backend:agy` subtasks through
   `run.sh` in parallel (bounded), printing `--- AGY [label] ---` blocks and listing
   `--- NATIVE [label] ---` subtasks; `team_plan.py` writes each subtask to `$WORK/<idx>.task`
   and team.sh addresses them by **msys-form `$WORK/<idx>.task`** (NOT the Windows-form path
   python echoes back — short-name mismatch breaks the reopen). Deps are honored by calling
   team.sh once per dependency **wave**.
4. Claude solves the native subtasks (≤ claude cap), **verifies** every result against its
   criterion, **fixes** failures in a bounded loop (default 1 attempt; a bare
   `MMT_NATIVE_HANDOFF` counts as a fail → solve natively), then synthesizes.

**Ultracode path (the full implementation):** when the Workflow tool is available, `/team`
runs `workflows/team.mjs`, which does the entire pipeline deterministically: decompose agent
(emits `deps` + `verify`) → dependency-ordered **waves** (`parallel()` per wave; agy agents
shell out to `run.sh`, native agents solve, upstream results injected as context) → per-result
**verify** agent (`{pass, reason, fix_hint}`) → **bounded fix** re-dispatch → synthesize. Args:
`{task, caps, pluginRoot, verify?=true, maxFixLoops?=1 (max 3)}`. Returns
`{plan, counts:{agy,native,verified,failed}, results, final}`. Determinism-safe (no
Date/random APIs — they break Workflow resume) and tolerates `args` as object **or** JSON string.

## Proactive delegation hook (opt-in)

`scripts/hooks/proactive-route.sh` is a **UserPromptSubmit** hook (registered in
`hooks/hooks.json`). When `[proactive].enabled = true` in `roster.json`, it runs each submitted
prompt through `route.sh`; if the decision is `backend=agy`, it injects a one-shot reminder
(`hookSpecificOutput.additionalContext`) nudging Claude to delegate via the
`multi-model-team:delegate` agent / `/team` instead of solving inline. **Deterministic firing,
soft compliance** — the reminder always appears under the conditions; acting on it stays Claude's
call. It never fires for slash commands or prompts that route to native (judgment/RE/systems).

Config lives in `[proactive]` (`enabled`, `max_chars`, `min_chars`, `rules` CSV allowlist);
`config.py proactive-env` emits these as `MMT_PROACTIVE_*`. **Cost discipline:** when disabled
(the default) the hook bails via a pure-bash `[proactive].enabled` pre-check **before spawning any
python** — so installing it costs ~nothing until opted in. Hard kill switch: `MMT_PROACTIVE_DISABLE=1`.
Injection-safe: the prompt reaches `route.sh` only on stdin, never as an argument, and is never
echoed back into the reminder. Tests live under `── Unit: proactive hook` in `tests/run_tests.sh`.

## Config = one JSON file (`config/roster.json`)

All config is JSON (hard cut from TOML). Five top-level sections (`_comment`/`_about`/`_note`
keys are inline docs the parsers ignore):

- **`defaults`** — `preset`, `fallback`, `quota_fallback` (ordered backend chain).
- **`backends`** — each key is a backend a route can target. `enabled` gates use; `kind` selects
  the invoker in `backends.sh`. **Only `kind:"gemini"` (agy) has an invoker today**; `codex`/
  `opencode` are `enabled:false` stubs — enabling one without an invoker just health-fails and
  falls through to the next hop. Adding a real backend = add a `_mmt_invoke_<kind>` +
  `mmt_be_*` case and flip `enabled`; no other code changes.
- **`agents`** — each delegation subagent: `enabled`, `backend`, `tier`, `dispatch`
  (`route`=let the router decide; `forced`=pin backend+tier), `model`, `color`, `role`. The
  `.md` files in `agents/` are **generated** from this by `scripts/lib/gen_agents.py` — edit the
  JSON then run it; `enabled:false` deletes the agent's `.md` so Claude Code stops surfacing it.
- **`routes`** — first-match-wins rules (was `[[route]]`); `match.py` skips the array's `_comment`
  marker objects. Route invariants (Opus hard-line first, multimodal before judgment-coding,
  judgment-coding above the commodity agy rules) are unchanged — just JSON now.
- **`proactive`** — the UserPromptSubmit nudge config.

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
- **Backends:** codex/opencode are config-only additions later (health-gate so an unavailable
  CLI falls through). Hook is intentionally `Read`-only for now (widen on evidence).
