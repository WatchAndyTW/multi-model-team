# Module interface contract — Node ESM rewrite

This is the binding contract for the `rewrite/node-esm` port. Every module below is a separate
parallel worker. **Code against these signatures, not against another worker's file** (their file
may not exist yet). Integration + a parity-verify pass reconcile any drift. All modules are ESM
(`.mjs`, `export`/`import`), **zero runtime dependencies** (Node stdlib only), and must run on
**win32 / linux / darwin**.

Parity rule: each port must reproduce the *observable behavior* of the bash/python original it
replaces. Where the original still exists on this branch, validate by diffing outputs
(`bash scripts/route.sh` vs `node src/bin/route.mjs`, etc.).

---

## `src/lib/platform.mjs` — cross-platform OS layer (NEW; native-authored)

The linchpin that makes Linux/macOS work. No imports from other project modules.

```js
export const PLATFORM;                    // 'win32' | 'linux' | 'darwin'
export function isWindows();              // boolean
export function homeDir();                // os.homedir()
export function stateDir();               // cache dir for HUD state.
//   MMT_STATE_DIR override > (posix: $XDG_CACHE_HOME/mmt) > ~/.cache/mmt  (parity on all OSes)
export function resolveBinary(name, opts);
//   opts: { envVar?:string, candidates?:string[] }  -> absolute path string or `name` (PATH fallback).
//   search order: process.env[envVar] > PATH (where/which-free: scan process.env.PATH) > candidates
//   (with ~ and $LOCALAPPDATA/$HOME expansion) > name. Per-OS default candidates live in backends.mjs.
export function hasPtyWrapper();          // boolean: winpty present (win32) OR `script` present (posix)
export function ptyWrap(argv, opts);
//   Wrap an argv so a child that gates on isatty(stdout) still emits.
//   opts: { needTty?:boolean (default true) }
//   returns { argv: string[], usedPty: boolean }
//   win32:  winpty -Xallow-non-tty -Xplain <argv...>           (winpty flags overridable via env later)
//   linux:  script -qec '<shell-quoted argv>' /dev/null        (GNU util-linux)
//   darwin: script -q /dev/null <argv...>                      (BSD arg order)
//   If needTty is false OR hasPtyWrapper() is false -> { argv, usedPty:false } (passthrough; caller
//   lets the chain fall through if the bare call yields nothing). MUST shell-quote safely on linux.
```

Notes: the winpty/`script` choice is the ONLY place OS branching for the TTY gate belongs. Keep the
linux `script -c` command-string builder injection-safe (a prompt may contain quotes/`$`).

---

## `src/lib/config.mjs` — roster.json loader (replaces config.py)

```js
export function loadRoster(path);         // JSON.parse(roster.json) -> object. Throws on bad JSON.
export function defaults(roster);         // { preset, fallback, quota_fallback:[...] }
export function backend(roster, name);    // normalized backend cfg or { enabled:false } if missing/unknown.
//   fields consumed downstream: enabled, kind, bin, bin_candidates[], cmd, model_tiers{cheap,standard},
//   use_winpty(bool), winpty_flags[], oneshot_flag, sandbox_flag, extra[], print_flag, hard_timeout,
//   quota_patterns[], quota_exit_codes[].
export function agents(roster);           // array of agent cfgs (for gen-agents).
export function routes(roster);           // array of route rules, _comment objects filtered out.
export function proactive(roster);        // { enabled, max_chars, min_chars, rules[], guard_spawns, enforce_spawns }
export function teamConfig(roster);       // { dispatch_backends[], verifier, caps{}, tier_models{}, verify, max_fix_loops, relay_model }
```
Replaces the `config.py {defaults-env|backend-env|proactive-env|team-config}` bash-eval contract with
plain JS objects. **No substring gating** — real JSON.parse (this fixes the fragile bash gate).

## `src/lib/score.mjs` — classifier (replaces score.sh)

```js
export function charCount(task);                 // integer (code points, parity with `wc -m`)
export function classify(task, tagsPath);        // string[] of de-duplicated type labels.
//   reads config/tags.txt: each non-blank/non-`#` line = "<label> <ERE>", ERE matched
//   case-insensitively against the full task. A label may appear on multiple lines (any match wins).
```

## `src/lib/router.mjs` — decision engine (replaces match.py)

```js
export function decide({ task, roster, tagsPath, preset });   // -> decision object
//   decision = { backend, model, tier, rule, native:boolean, preset, score:{chars, types:[...]} }
//   first-match-wins over routes(roster); when {} clauses: type-intersection + min_chars/max_chars.
//   apply preset (budget|premium) override; resolve tier->model + native bool. PRESERVE rule ORDER
//   and the documented invariants exactly (Opus hard-line first, multimodal before judgment-coding, …).
```

## `src/bin/route.mjs` — CLI (replaces route.sh)

Reads task from stdin (preferred, injection-safe) or args; flags `--preset <p>`, `--explain`
(breakdown to stderr), `--tags <path>`, `--roster <path>`. Prints decision JSON to stdout. On no
task -> exit non-zero. Degrades to `{backend:native,...,rule:"no-..."}` only on internal error.

---

## `src/lib/backends.mjs` — backend invokers (replaces backends.sh; native-authored)

```js
export async function invoke(backendCfg, prompt, opts);
//   -> { ok:boolean, stdout:string, stderr:string, code:number, quota:boolean }
//   dispatch on backendCfg.kind: 'gemini' (agy) | 'codex'. Unknown kind -> { ok:false, code:127 }.
//   agy: build argv [bin, print_flag, prompt, ...extra]; if use_winpty -> platform.ptyWrap(argv);
//        spawn with an OPEN, IDLE stdin pipe kept open until exit (Node replaces the bash FIFO:
//        stdio:['pipe',...] and DO NOT end stdin until the child closes). hard_timeout kill.
//   codex: [bin, oneshot_flag('exec'), ...extra(incl -s read-only), prompt]; plain stdin, no pty.
export async function health(backendCfg);        // boolean. agy: `agy --version` WITHOUT pty (winpty
//        yields empty for --version). codex: `codex --version`. Honors resolveBinary candidates.
export function clean(raw);                       // strip CR + winpty teardown asserts + OSC/CSI/ESC noise + trailing blanks.
export function quotaExhausted(blob, patterns, exitCode, exitCodes);  // pure JS substring + code match (no grep).
```
agy default bin candidates (pass to resolveBinary): win32 `%LOCALAPPDATA%/agy/bin/agy.exe`; linux
`~/.local/bin/agy`,`/usr/local/bin/agy`,`/usr/bin/agy`; darwin same + `/opt/homebrew/bin/agy`.

## `src/lib/state.mjs` — HUD state (replaces state.sh)

```js
export function start({ id, backend, model, rule });   // open++, set active_*, accumulate approx_in_chars
export function end({ id, backend, model, rule, code, durMs, outChars, fallback }); // open--, calls++, set last_*
//   writes platform.stateDir()/state.json — flat one-field-per-line JSON (statusline parses it fork-free).
//   lock via mkdir-spinlock with stale-break; atomic write (tmp + rename, copy fallback).
```

## `src/bin/run.mjs` — executor + fallback chain (replaces run.sh; native-authored)

Decision: `--decision '<json>'` (forced, skips router) else route via router.decide on stdin task.
Chain = [decision.backend] + dedup(defaults.quota_fallback). Per hop: load backend cfg, skip if
disabled, `health()`-gate, `invoke()`. On quota -> record `last error`, next hop. On non-zero/empty
clean output -> capture+sanitize stderr into `last error`, log to our stderr, next hop. On success ->
print clean stdout, exit 0. On native hop / full exhaustion -> print
`MMT_NATIVE_HANDOFF tier=… rule=… reason="…(last error: …)"`. Wraps state.start/end around each hop.

---

## `src/lib/team-spec.mjs` (team_spec.py) · `src/lib/team-plan.mjs` (team_plan.py) · `src/lib/gen-agents.mjs` (gen_agents.py) · `src/bin/team.mjs` (team.sh)

```js
// team-spec.mjs
export function parseCaps(spec);          // "N:gemini,M:claude" -> { gemini, codex, claude, total, source, note }
export function splitSpec(rawText);       // -> { caps, task, source }  (peel leading cap spec; aliases; clamp<=16)
// team-plan.mjs
export function planToManifest(plan, workdir);  // write <idx>.task files (raw, LF), return TSV manifest rows
//   backend normalize: agy/gemini->AGY, codex->CODEX, claude/native->NATIVE(default). tier allowlist
//   + TSV-injection hardening (neutralize \t,\n in tier). label sanitized [A-Za-z0-9._-] <=48.
// gen-agents.mjs
export function generateAgents(roster, agentsDir);  // write/remove agents/<name>.md from agents(roster);
//   GENERATED header; dispatch 'route' -> `node run.mjs "<task>"`; 'forced' -> `node run.mjs --decision {…}`.
// team.mjs (bin) — scripted no-agents fan-out: --plan <file> --gemini-cap G -> parallel run.mjs subprocs.
```

---

## `src/lib/hook-common.mjs` — shared hook runtime (NEW; the reliability core)

```js
export async function readPayload();      // read+JSON.parse hook stdin (bounded, timeout-guarded). null on empty/bad.
export function proactiveGate(roster);    // { enabled, guard_spawns, enforce_spawns, ... } via config.proactive — REAL parse, no substring scan.
export function emit(obj);                // JSON.stringify hookSpecificOutput to stdout.
export function allow(ctx);               // -> emit PreToolUse allow (+optional additionalContext)
export function deny(reason);             // -> emit PreToolUse deny (+reason)
export function promptContext(ctx);       // -> emit UserPromptSubmit additionalContext
export function decideTask(task, {roster, tagsPath});  // in-process router.decide (NO bash fork) -> decision
export function debugMark(name, info);    // append firing marker to stateDir()/hooks.log when MMT_HOOK_DEBUG=1
```
Each hook = **one node process**: read payload -> gate -> in-process route -> emit. No child processes,
no substring gate. This is what fixes the intermittent-firing bug (collapses the 6–7-fork msys storm
to a single short-lived node proc, well under any timeout). Kill switches preserved:
`MMT_PROACTIVE_DISABLE=1`, `MMT_HOOK_DISABLE=1`. Fail-OPEN on any uncertainty.

## `hooks/*.mjs` — `heavy-read-guard` · `proactive-route` · `spawn-route-guard`

Reimplement the three live bash hooks on `hook-common`, same semantics (incl. OMC-aware spawn guard:
nudge-never-deny for OMC team workers; exempt `multi-model-team:*` + `[mmt-team-worker]` + already-
routed tasks). The `Workflow` guard is **dropped** (empirically never fires — no `wf-guard.log`); its
nudge moves into `workflows/team.mjs`. `hooks/hooks.json` commands change to
`node "${CLAUDE_PLUGIN_ROOT}/hooks/<x>.mjs"`.

## `statusline/statusline.mjs` (replaces statusline.sh)

Single node proc, minimal imports. Read stateDir()/state.json, render the three HUD modes
(active `⟳`, idle `◦`, empty). Keep it fast (no heavy requires).
