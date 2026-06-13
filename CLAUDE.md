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
   │    └─ scripts/lib/match.py   first-match-wins over config/roster.toml [[route]] (tomllib)
   ▼  decision JSON {backend, model, tier, rule, native}
   │
   ▼  scripts/run.sh          executor
        ├─ scripts/lib/config.py    roster.toml → bash-sourceable vars (no jq)
        ├─ scripts/lib/backends.sh  agy resolve + winpty invoke + clean() + quota detect
        ├─ scripts/lib/state.sh     HUD state → ~/.cache/mmt/state.json
        └─ on agy success: cleaned stdout;  else: MMT_NATIVE_HANDOFF sentinel
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
config/roster.toml           routing rules + agy backend + thresholds + quota patterns
config/tags.txt              task-type classifier — `<type> <ERE>` per line
scripts/route.sh             decision only
scripts/run.sh               executor + fallback chain + HUD state
scripts/lib/{score.sh,match.py,config.py,backends.sh,state.sh,common.sh}
scripts/hooks/heavy-read-guard.sh   PreToolUse guard for oversized RE-dump reads
statusline/statusline.sh     fork-free HUD
agents/{delegate,av-research,bulk-summarizer}.md
commands/{team,route-test}.md
hooks/hooks.json             PreToolUse matcher (Read only, narrow on purpose)
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

**Invariants enforced by rule ORDER in `roster.toml` (first match wins):**
1. OPUS hard-line rules sit first — RE/injection/systems-hard can never fall through to agy.
2. `multimodal` (Gemini-exclusive) is the first agy rule — A/V must go to agy even if it
   also carries a judgment word.
3. `judgment-coding` is ordered ABOVE the commodity agy rules — a task with a judgment
   signal (refactor/bugfix/integration) goes to Sonnet even if it also mentions a button/
   script/config. "When uncertain between agy and sonnet, prefer sonnet; never agy on a guess."
4. Unclassified → `catch-all-safe` → Sonnet.

**Tuning needs no code edits:** edit `config/tags.txt` to change *what type* a task is, and
`config/roster.toml` to change *where a type routes*. Verify with `/route-test`. When editing
the OPUS hard-line regexes, keep them tight — a bare word like `binary`/`hooks`/`injection`
will false-positive on "binary search" / React "hooks" / "dependency injection" and force
Opus. When editing agy regexes, keep them specific — bare `extract`/`config file` steal
refactor/judgment work. Add a regression test in `tests/run_tests.sh` for any routing change.

Presets (`[defaults].preset` or `--preset`): `budget` pushes borderline judgment-coding to
agy; `premium` pulls standard-coding up to Sonnet (keeps agy for its categorical edges).

---

## Conventions & constraints (Windows / msys)

- **No `jq`.** statusline parses state.json with a fork-free pure-bash loop (state.json is
  always one-field-per-line). `python3` (3.11+, `tomllib`) parses TOML in route/run only.
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

- **P2 — quota grounding:** `quota_patterns` in `roster.toml` are unvalidated defaults;
  harden `quota_patterns`/`quota_exit_codes` on the first real agy credit-exhaustion error.
- **Backends:** codex/opencode are config-only additions later (health-gate so an unavailable
  CLI falls through). Hook is intentionally `Read`-only for now (widen on evidence).
