# multi-model-team — project guide for Claude

A Claude Code **plugin** that delegates token-heavy, self-contained tasks to local
pre-authed CLI backends — **`agy`** (Gemini), **`codex`** (OpenAI Codex CLI), **`opencode`** (OpenCode CLI)
and **`grok`** (Grok Build, xAI's harness) — choosing
backend/model by task size and type, with credit-exhaustion fallback to native Claude and a
glanceable statusline HUD.

**Stack:** Node ESM (`.mjs`), zero-build, Node >=18. **One native runtime dependency: `node-pty`**
(the agy lane runs under a real pseudo-terminal — ConPTY on Windows, forkpty on POSIX); everything
else is Node stdlib. Cross-platform (Windows/Linux/macOS). `package.json` `"type":"module"`.

**Status:** built, adversarially reviewed, and green. `npm test` passes **188/188** offline
(no backend calls; live agy/codex behaviour is smoke-tested by hand, not via a `npm test` gate).
Four live backends: **agy** (Gemini), **codex** (OpenAI Codex CLI), **opencode** (OpenCode CLI) and
**grok** (Grok Build).
In `/team` any of them can be staffed as the reviewer (`review:codex:2`); unstaffed, review falls to
Claude. See `README.md` (user-facing), `PROBES.md` (grounded CLI findings), and
`docs/REASONING.md` (the `/reasoning` design contract).

**Why the Node ESM rewrite?** The original bash implementation forked ~6–7 processes per invocation
under a 10 s msys timeout and was intermittently killed. Everything is now plain Node ESM: real
`JSON.parse` instead of substring gating, no `jq`/`python3`/`grep` in hot paths.

**Removed, deliberately — don't reintroduce:** the `hooks/` tree (a UserPromptSubmit delegation
nudge, a `PreToolUse` spawn guard, and a `/reasoning`·`/team` fan-out guard) plus the `/route-test`
command and the roster's `proactive` section. The hooks fired on every prompt to enforce behaviour
the commands already specify, and `/route-test` duplicated `node src/bin/route.mjs --explain`.

---

## ⚠️ Backend invocation quirks

### agy (Gemini) — needs a TTY → runs under node-pty

`agy` gates its output on `isatty(stdout)`. Run through a normal pipe it **exits 0 and prints
nothing** — a silent no-op that looks like success. The plugin therefore runs agy under a real
**pseudo-terminal via `node-pty`** (`backends.mjs runPty`): ConPTY on Windows 10/11, forkpty on
Linux/macOS. `isatty(stdout)` is true, so agy emits — **with no visible console window, working even
from a fully headless parent** (a Bash-tool subshell, a `/team` or `/reasoning` sub-agent).
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

Real model names come from `agy models`; the roster uses the **ID form** (left column) —
`gemini-3.1-pro-low` (standard), `gemini-3.6-flash-low` (cheap), `gemini-3.1-pro-high` (high).
The display strings (`Gemini 3.1 Pro (Low)`) also work but carry spaces and parens. Binary auto-resolves via `platform.resolveBinary`: `$MMT_AGY_BIN`
→ PATH scan → default candidates (`$LOCALAPPDATA/agy/bin/agy.exe` on Windows;
`~/.local/bin/agy`, `/usr/local/bin/agy`, `/usr/bin/agy` on Linux; same + `/opt/homebrew/bin/agy`
on macOS).

### opencode — no TTY, prompt on stdin, and it IGNORES cwd

`opencode run` is the non-interactive lane. Like codex (and unlike agy) it needs **no pty** — piped
stdout works headlessly — and the **prompt rides on stdin**: `opencode run` with no positional
message reads the message from stdin, which sidesteps the same Windows `.cmd` newline-truncation
bug codex hit. On Windows the binary is a real `opencode.exe`, so no `cmd.exe` wrapping occurs.

Read-only vs writable is expressed through opencode's **agent**, not a sandbox flag:
`--agent plan` (read-only, default lane) vs `--agent build --auto` (full-auto, `/team --writable`).

**The one real trap:** opencode **ignores the cwd it is spawned with** and resolves its own project
root. A `--writable --cwd <worktree>` dispatch reported success while writing into the PARENT repo —
silently defeating the per-subtask worktree isolation. Its `--dir` flag is the fix and confines
writes correctly; the plugin passes it whenever a `--cwd` is given, via the roster-tunable
`cwd_flag`. Full detail in `PROBES.md`.

**No model is chosen for opencode by design** — `models: {}` in the roster means the invoker omits
`--model`, so opencode runs on whichever model the user configured in opencode itself. Note that a
slow default model can exceed `hard_timeout` (a local 27B model took ~40 min for a one-word answer
on the dev machine); pin a faster model or raise the timeout if that bites.

opencode claims **no auto-route lane** by default: it never silently takes work from agy/codex, and
runs only when explicitly chosen (its agent, `/team`, a `/reasoning` panel, or the fallback chain).

### grok (Grok Build) — no TTY, prompt as argv, and `plan` is NOT read-only

`grok -p <prompt>` is the headless lane (prints to stdout and exits) and works through a plain pipe —
**no pty**, like codex/opencode. The prompt rides as an **argv element**: `--prompt-file` emits
nothing through a pipe (it wants the TUI), and argv is safe here because the binary is a real
`grok.exe`, so Node passes it straight to `CreateProcess` with no `cmd.exe` to truncate at the first
newline and no shell to parse it. Known limit: the Windows ~32k command-line cap applies to very
large `/team` payloads.

**The trap:** read-only is `--permission-mode default`, **not** `plan`. `plan` sounds read-only and
is not — grok created a file under it. `default` does block writes: with no TTY, a tool call needing
approval is refused, and a read/answer task returns normally. Deny rules are not a substitute — grok
routed around `--deny Write` via the terminal.

**But the refusal is not always clean, so this lane is not fail-safe.** Observed live: grok emitted
partial narration, hit a tool call it needed to RUN, and exited 0 with that stub — and `run.mjs`
scores exit-0-plus-output as SUCCESS, so a truncated answer comes back as if it were the result
(only the empty-output flavour falls through). The lane never writes, but it can return an
unfinished answer: treat a read-only grok result as **unverified** (what `/team`'s verify stage is
for), and staff grok `--writable` — `bypassPermissions`, confined to the worktree by `--cwd` — for
work that must execute commands. Full detail in `PROBES.md`.

Models come from `grok models` (`grok-4.5` plus whatever you configure); the roster ships
`models: {}` so grok uses its own default, the same decision as opencode.

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
        ├─ src/lib/backends.mjs  backend invoke (by kind: gemini/codex/opencode) + clean() + quota
        ├─ src/lib/platform.mjs  ptyWrap (winpty/script), resolveBinary, stateDir
        ├─ src/lib/state.mjs     HUD state → stateDir()/state.json
        └─ on backend success: cleaned stdout;  else: MMT_NATIVE_HANDOFF sentinel
   │
   ▼  statusline/statusline.mjs  fork-free HUD line (reads state.json)
```

`run.mjs` walks a fallback chain = chosen backend + `quota_fallback` (deduped). Default:
`["agy","codex","opencode","native:sonnet"]` — agy quota exhaustion falls through to codex, then
opencode, then to native
Claude (`MMT_NATIVE_HANDOFF` sentinel). When a backend fails (non-zero or empty output), `run.mjs`
captures stderr into `last error` and carries it into the handoff `reason=` — so the cause is
visible instead of a silent empty result.

---

## Directory map

```
.claude-plugin/plugin.json      manifest (auto-discovers commands/ and agents/)
settings.json                   reference statusLine (see README HUD note)
config/roster.json              ALL config: defaults + backends + agents + routes + team + roles + reasoning
config/tags.txt                 task-type classifier — `<type> <ERE>` per line (stays a flat file)
src/lib/platform.mjs            cross-platform OS layer: PTY wrap, binary resolve, state dir (NEW)
src/lib/config.mjs              roster.json loader → plain JS objects (replaces config.py)
src/lib/score.mjs               char count + keyword type classification (replaces score.sh)
src/lib/router.mjs              first-match-wins decision engine (replaces match.py)
src/lib/backends.mjs            agy/codex invokers + clean() + quota (replaces backends.sh)
src/lib/state.mjs               HUD state read/write (replaces state.sh)
src/lib/roles.mjs               /team STAFFING: role catalog, spec grammar, resolveStaffing (the ONE
                                place a job gets a backend; unstaffed -> Claude)
src/lib/team-spec.mjs           /team spec entry point — both grammars -> one resolved staffing
src/lib/team-plan.mjs           plan.json → per-subtask files (replaces team_plan.py)
src/lib/reason-spec.mjs         /reasoning panel-spec parser: expandPanel / parsePanel / splitPanel
src/lib/gen-agents.mjs          regenerate agents/*.md from roster.json (replaces gen_agents.py)
src/lib/validate-config.mjs     roster.json validator (unique route names, valid tiers/backends/agents)
src/bin/route.mjs               task → decision JSON CLI (replaces route.sh)
src/bin/run.mjs                 executor + fallback chain + HUD state (replaces run.sh)
src/bin/team.mjs                scripted CLI-backend fan-out (replaces team.sh)
src/bin/reason.mjs              scripted panel fan-out engine for /reasoning (no-agents path)
src/bin/setup.mjs               /mmt-setup engine: create/reset ~/.claude/mmt-roster.json
statusline/statusline.mjs       fork-free HUD (replaces statusline.sh)
agents/{agy,codex,opencode,grok}.md  GENERATED from roster.json (gen-agents.mjs)
commands/{team,reasoning,mmt-setup}.md   /team = multi-agent fan-out; /reasoning = Fusion pipeline; /mmt-setup = durable personal roster setup
workflows/team.mjs              Ultracode dynamic-workflow fan-out (Workflow tool)
workflows/reasoning.mjs         Ultracode Fusion workflow: Panel → Judge → Synthesize
test/*.test.mjs                 offline test suite (npm test — node --test)
docs/REASONING.md               design contract for the /reasoning Fusion pipeline
docs/INTERFACES.md              module interface contract (binding signatures for the Node ESM port)
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
`config/roster.json` to change *where a type routes*. Verify with `node src/bin/route.mjs
--explain` (task on stdin). When editing
the OPUS hard-line regexes, keep them tight — a bare word like `binary`/`hooks`/`injection`
will false-positive on "binary search" / React "hooks" / "dependency injection" and force Opus.
When editing agy regexes, keep them specific — bare `extract`/`config file` steal
refactor/judgment work. Add a regression test in `test/*.test.mjs` for any routing change.

Presets (`[defaults].preset` or `--preset`): `budget` pushes borderline judgment-coding to
agy; `premium` pulls standard-coding up to Sonnet (keeps agy for its categorical edges).

**Disabling a backend is a first-class operation.** Three switches, in precedence order:

| switch | scope | effect |
|---|---|---|
| `backends.<name>.enabled: false` | permanent (roster) | backend is off everywhere |
| `MMT_DISABLE_BACKENDS=codex,agy` | one shell | blocklist |
| `MMT_ONLY_BACKENDS=agy` | one shell | allowlist — everything else off |

`native` is **never** disable-able; it is the guaranteed final fallback. A disabled backend is
honoured *at routing time*, not just at dispatch: `router.matchRule` **skips** any rule whose
backend is off, so matching continues to the next rule and the decision is honest. (Previously the
router returned a backend `run.mjs` would then refuse, so the decision JSON advertised a
destination the user had switched off.) A preset that biases *into*
a disabled backend is undone rather than emitted. `skippedDisabled` in the decision reports what was
passed over and why. Inspect it all with `node src/bin/route.mjs --backends`.

**Model selection** resolves through an explicit ladder, so any tier keys are usable — not just
`cheap`/`standard`:

```
--model flag  >  a forced decision's pinned model  >  MMT_MODEL_<BACKEND>  >
exact tier  >  backend default_tier  >  standard  >  cheap  >  first declared  >  '' (no flag)
```

An empty result is meaningful: **pass no model flag**, letting the CLI use its own default (how
opencode is wired). `model_aliases` give short handles (`flash` → `gemini-3.6-flash-low`) usable in
a tier, `--model`, or the env override. The `high` tier asks a backend for its strongest model and
falls back safely when it declares none. `defaults.native_models` is the **single** place a tier
becomes a Claude model — `team.tier_models` (which duplicated it) is gone; `teamConfig()` forwards
this map instead, and a /team role's `tier` is what selects through it.

agy's shipped models use the **ID form** from the left column of `agy models`
(`gemini-3.1-pro-low`), not the display strings — both work, but ids carry no spaces or parens.

---

## /team — multi-model team pipeline (v0.3)

`/team [--writable] [staffing spec] <task>` runs a task through a staged **plan → exec → verify → fix**
pipeline: **native, agy, codex and opencode are equal tools**, and **the user's staffing is the only
thing that decides which one does which job** (see the ROLE system below). Anything unstaffed runs on
Claude. Stages: **decompose → dispatch (dependency-aware) → verify → fix (bounded) → synthesize**.
Flow (in `commands/team.md`):

**Two modes (`--writable`).** *read-only (default):* CLI agents stay read-only (`-s read-only`), return
text, and the **orchestrator applies edits directly to the CURRENT branch — no branch, no worktree, no
PR** (back-compat). *writable (`--writable`):* each subtask gets its **own git worktree + branch** off
HEAD; the agent makes **real changes** there (CLI **full-auto** via `run.mjs --cwd <wt> --writable`,
selecting the backend's `writable_extra` instead of `extra`); then a deterministic **Setup → Integrate**
pair of Bash sub-agents (the Workflow runtime has no fs/git) create the worktrees and **merge each into
one integration branch `mmt/team-<slug>`** off HEAD — **the orchestrator resolves any merge conflicts
itself and completes the merge**, so you get one finished, conflict-free branch (only a conflict it
genuinely can't reconcile is left as `unresolved`); the user's branch is untouched (no auto-merge) and
**no `gh` PR** is created. Worktrees live under
`.mmt/worktrees/<slug>/` (gitignored). Enable per-invocation (`--writable` / Workflow `args.writable`)
or via roster `team.mode:"writable"`. The full-auto sandbox is config-tunable: each backend's
`writable_extra` in `roster.json` (codex `--dangerously-bypass-approvals-and-sandbox`; agy keeps its
`--dangerously-skip-permissions`, differing from read-only only by the worktree cwd).

1. Resolve the staffing via `src/lib/team-spec.mjs --split` → `{roles, caps, task, source, writable}`.
   Both grammars (role spec, backend-only spec) land on ONE resolved table; `.caps` is projected
   off it for the scripted path's `--gemini-cap`.
2. Claude decomposes the task, then **writes `.mmt/plans/plan.json`** (array of
   `{label, task, backend, tier, deps?, verify?}`) via the Write tool — `.mmt/` is this plugin's
   state dir (NOT `.omc/`, even under OMC) — task text stays inert
   data, never shell-parsed (injection-safe boundary).
   `deps` = labels this subtask consumes; `verify` = a one-line acceptance criterion.
   `src/lib/team-plan.mjs` **ignores `deps`/`verify`** (inert in the scripted path).
3. Claude dispatches each subtask as its **own parallel `Task` sub-agent**, a dependency **wave**
   at a time — the whole wave spawned in ONE message (OMC-style fan-out). CLI subtasks get a
   **faithful-relay** worker that runs `node src/bin/run.mjs --decision {backend}` and returns the
   CLI's stdout verbatim (a bare `MMT_NATIVE_HANDOFF` → lead spawns a visible native worker).
   (`src/bin/team.mjs --plan <file> --gemini-cap G` remains as a **scripted no-agents alternative**
   — parallel `run.mjs` subprocesses, `--- AGY/CODEX/NATIVE [label] ---` blocks.)
4. The lead **verifies** every result against its criterion via the **staffed reviewer(s)** (rule
   `team-verify` forces their backend; visible native judgment falls back if a reviewer CLI is
   unavailable), **fixes** failures in a bounded loop (default 1 attempt), then synthesizes.

**Ultracode path:** when the Workflow tool is available, `/team` runs `workflows/team.mjs`, which
does the entire pipeline deterministically: decompose → dependency-ordered waves → verify →
bounded fix re-dispatch → synthesize. The faithful relay (`dispatchRelay`) is a PURE PIPE:
forced into `{stdout, backend_ran}` schema, forbidden from solving/analyzing the payload. Each
result carries `ranOn` = the backend that *actually* produced it. A reviewer staffed on `native`
skips the relay and judges on Claude directly.

Args: `{task, roles, pluginRoot, teamConfig, verify?=true, verifier?, maxFixLoops?=1 (max 3)}`. Returns
`{plan, backends, staffing:{workers,verifiers,fixers,defaulted}, verifier,
counts:{byBackend,byRole,byStage,ranOn,verified,failed,nativeFallbacks}, results, final}`.
Agent labels carry the role and backend — `gemini:executor:<label>`, `codex:code-reviewer:<label>`,
`native:` etc. Omitting `args.roles` runs the whole pipeline on Claude — **the workflow never
auto-staffs a CLI**. Native model is **dynamic by role tier** through `defaults.native_models`.
Determinism-safe (no Date/random APIs) and tolerates `args` as object **or** JSON string.

## The /team ROLE system — the ONLY staffing mechanism (oh-my-claudecode parity)

A `/team` invocation is staffed by **job**. This is the single mechanism that decides which backend
does what: there is no eligible-backend list, no per-backend cap panel and no configured verifier
sitting behind it. (There used to be — `team.dispatch_backends` / `team.caps` / `team.verifier` auto-
assigned work from config while the role spec assigned it explicitly. Two mechanisms competing over
one decision; the config one silently won in places. It is gone.)

```
/team orch:claude:2;impl:opencode:1,claude:2;review:codex:2 build a REST CRUD service
```

`role:backend:count` — comma-separated **within** a role, semicolon-separated **between** roles.
Roles and backends are **independent**: any role runs on any backend, and one role can span several
(`impl:opencode:1,claude:2`). `backend:count` and `count:backend` both parse; a bare `role:backend`
means one worker; a bare `role` means one worker on `roles.default_backend`.

**Vocabulary = OMC's.** All 19 OMC agents are roles (`planner`, `executor`, `verifier`,
`code-reviewer`, `security-reviewer`, `designer`, `debugger`, `explore`, `critic`, `analyst`,
`architect`, `test-engineer`, `tracer`, `writer`, `document-specialist`, `scientist`, `git-master`,
`code-simplifier`, `qa-tester`) plus **`fixer`** for the fix stage (OMC staffs team-fix with
executor/debugger; naming it makes that stage assignable). `orch`/`impl`/`review` are aliases for
`planner`/`executor`/`code-reviewer`. Each role's default tier mirrors OMC's model choice
(opus→`high`, sonnet→`standard`, haiku→`cheap`) and resolves **per backend** through the normal
model ladder — so `high` on agy means agy's strongest model, not Opus.

**Stages** run `plan → prd → exec → verify → fix` (OMC's `team-plan … team-fix`). Every role belongs
to exactly one. `plan`/`prd`/`exec` are **decomposed into subtasks**; `verify` and `fix` staff the
pipeline's **own review/repair loop** and are never planned as work — that split is what lets one
mechanism drive both "who implements" and "who reviews".

**The three fallback rules** (`resolveStaffing` in `src/lib/roles.mjs` — the one place a job gets a
backend):
1. **Unstaffed → Claude**, at that role's catalog tier (which is what picks the model via
   `defaults.native_models`). A CLI is *never* auto-staffed; it runs only where you put it.
2. **`fixer` follows `executor`** — staff `impl:opencode:2` and fixes go back to opencode. More
   precisely it follows the exec **stage**, so `designer:agy:2` also gets an agy fixer. An explicit
   `fix:claude:1` overrides it.
3. **A job is covered by any role on its stage.** `review:codex:2` IS the review job, so no second
   Claude verifier is added beside it; `designer:agy:2` staffs exec, so no phantom Claude executors.

A **backend-only spec** (`5:gemini,2:claude`) means "use these to do the work" → they become the
**executors**, rule 2 gives them the fixer, and rule 1 puts the reviewer on Claude. With **no spec at
all**, the whole pipeline is Claude (`executor` ×4, `verifier` ×1, `fixer` ×1).

**All config, no code:** `roster.json` → `roles` (`stages`, `default_backend`, `default_count`,
`core` = the always-needed jobs with their default worker count / `follows` / optional fallback
`backend`, and `catalog` with each role's `stage`/`tier`/`aliases`/`desc`). `src/lib/roles.mjs`
hardcodes only a small fail-safe catalog for when that section is unreadable. `node
src/lib/roles.mjs --list` prints the catalog; `--split` parses a spec, `--staff` shows the RESOLVED
table (including the Claude fallbacks).

**Enforcement in `workflows/team.mjs` (the part that makes it real):**
1. The decompose schema's `role` enum is limited to staffed roles, and `role` is **required**.
2. The limit is per **(role, backend) slot**. A subtask naming an unstaffed pair, or exceeding a
   staffed count, is **dropped with a log line** — never silently re-homed. The decompose's backend
   is deliberately *not* coerced to native for this reason.
3. Each kept subtask's tier is corrected to its role's tier.
4. Stage order is enforced by **rewriting it as dependencies**, so the existing dependency-wave
   scheduler carries it — no second scheduling mechanism, and later stages get earlier results.
5. Each worker receives a **role brief** (`You are acting in the "code-reviewer" role…`) and its
   label becomes `code-reviewer:<subtask>`. Reviewers get it too, so `security-reviewer` audits for
   vulnerabilities instead of doing a generic pass/fail. The `desc` rides in the resolved table
   because Workflow scripts have no filesystem access to re-read the roster.
6. Several staffed reviewers ⇒ each result must satisfy **all** of them (the default staffing is
   one, so the common case is exactly one review per subtask, unchanged).
7. A **disabled** backend can't be staffed: `resolveStaffing` drops it with a note and the job falls
   back to Claude — the same "honour the switch at decision time" invariant the router has.

**Backward compatible.** The backend-only spec (`5:gemini,2:claude`) still parses identically. The
grammars are *distinguished, not guessed*: a role spec starts with a known role word, a backend-only
spec with a number or backend word. `.caps` is still emitted (projected off the **worker** staffing)
so `--gemini-cap` and the scripted path keep working.

`test/team-staffing.test.mjs` runs the REAL `workflows/team.mjs` against a stubbed Workflow runtime
(offline — `agent()` is a stub, no backend spawns), so these rules are pinned behaviourally rather
than by string-matching the source.

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
- **Fallback path:** parallel `Task` sub-agents for the Panel, then
  native judge + synthesize. Scripted alternative: `src/bin/reason.mjs` (no agents, stdin question).

Config lives in `roster.json` `reasoning` section (panel, judge, synthesizer, cap, tier_models,
relay_model); full token vocabulary and override precedence documented in `docs/REASONING.md`.

## Config = one JSON file (`config/roster.json`)

All config is JSON. Six top-level sections (`_comment`/`_about`/`_note` keys are inline docs
the parsers ignore):

- **`defaults`** — `preset`, `fallback`, `quota_fallback` (ordered backend chain).
- **`backends`** — each key is a backend a route can target. `enabled` gates use; `kind` selects
  the invoker in `src/lib/backends.mjs`. **`gemini` (agy), `codex`, `opencode` and `grok` all have
  live invokers.** Adding a future backend = add `invoke`/`health` dispatch cases in `backends.mjs`
  and declare it here; no other code changes. That claim is now enforced: the /team spec vocabulary
  is DERIVED from the roster's backend keys (`roles.backendWords`), so a new backend is staffable
  (`impl:<name>:2`), spec-able (`2:<name>`) and dispatchable at once. It used to be false — the name
  also had to be hand-added to three hardcoded lists in roles.mjs, team-spec.mjs and team.mjs.
- **`agents`** — each delegation subagent: `enabled`, `backend`, `tier`, `dispatch`
  (`route`=let the router decide; `forced`=pin backend+tier), `model`, `color`, `role`. The
  `.md` files in `agents/` are **generated** from this by `src/lib/gen-agents.mjs` — edit the
  JSON then run `node src/lib/gen-agents.mjs`; `enabled:false` deletes the agent's `.md`.
- **`routes`** — first-match-wins rules; `src/lib/router.mjs` skips `_comment` marker objects.
  Route invariants (Opus hard-line first, multimodal before judgment-coding, judgment-coding above
  commodity agy rules) are unchanged.
- **`roles`** — the /team STAFFING system, and the only place a backend is assigned to a job:
  `stages`, `default_backend` (the unstaffed fallback = Claude), `default_count`, `core` (the
  always-needed jobs: default worker `count`, optional `follows`, optional fallback `backend`), and
  `catalog` mapping each role to its stage / default tier / aliases / description. Edited here, not
  in code — adding a role is a JSON entry.
- **`team`** — `/team` **pipeline knobs only**, read by `src/lib/config.mjs teamConfig()` and passed
  into `team.mjs` via `args.teamConfig`: `verify`, `max_fix_loops`, `relay_model`, `mode`. It picks
  no backends — `roles` does. `teamConfig()` also forwards `native_models` from `defaults` (the
  Workflow runtime can't read the roster, but the tier→model map must stay single-sourced).
  Precedence: built-in default < `team` < invocation arg.

**Module contract:** `src/lib/config.mjs` exports `loadRoster`, `defaults`, `backend`, `agents`,
`routes`, `teamConfig` — plain JS objects, real `JSON.parse`, no bash eval, no
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
  `$ARGUMENTS` into `!` bash blocks (RCE). `/team` and `/reasoning` do NOT inline-exec — they
  instruct Claude to run the binary via the Bash tool, feeding the task on stdin. Keep it that way.
- **HUD registration is manual.** A plugin's bundled `settings.json` does not register a
  top-level `statusLine`; the user adds the `statusLine` to their own `~/.claude/settings.json`
  with an absolute path pointing to `statusline/statusline.mjs`. `settings.json` here is a reference.
- **Binary self-location.** `src/bin/*.mjs` resolve sibling files via
  `import.meta.url` (Node ESM); agents/commands reference `${CLAUDE_PLUGIN_ROOT}`.
- **Cross-platform:** `src/lib/platform.mjs` is the only place OS branching for PTY/binary/state
  belongs. Developed on Windows and **tested on Linux/macOS** — the POSIX paths (the `script` PTY
  shim, XDG state dir, POSIX binary candidates) are exercised on a real POSIX box.

---

## Testing

```bash
npm test                         # offline: 188/188 routing + unit tests (no backend calls)
```

Keep the suite green. Add cases for any routing or behavior change. Tests live in `test/*.test.mjs`
and run with `node --test`. The suite is fully offline — there is no `MMT_LIVE` live-test gate; verify
agy/codex behaviour by hand against the installed CLIs.

---

## Open items

- **P2 — quota grounding:** `quota_patterns` in `roster.json` are unvalidated defaults. The
  detector is now **failure-gated** (`backends.quotaFromResult`): a successful call (exit 0 +
  non-empty output) is never treated as exhaustion, so a backend answer that merely *quotes* a
  pattern word (e.g. codex reading this repo's `quota_patterns`) is no longer discarded. Real
  exhaustion still relies on the heuristic patterns + `quota_exit_codes` — harden those on the
  first real agy/codex credit-exhaustion error.
- **Backends:** agy, codex and opencode are all live. Health-gate
  ensures an unavailable CLI falls through to the next fallback hop.
- **Linux/macOS:** POSIX PTY shim (`script`) and XDG state dir in `platform.mjs` are exercised and
  tested on a real POSIX box.
