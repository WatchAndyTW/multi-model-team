---
description: Run a task through the multi-model team pipeline — decompose into role-assigned subtasks, dispatch dependency-aware, verify each result, fix failures in a bounded loop, then synthesize. YOU staff it: a spec like "orch:claude:2;impl:opencode:1,claude:2;review:codex:2" says which backend does which job (oh-my-claudecode role vocabulary, stage order plan/prd/exec/verify/fix). Naming backends only ("5:gemini,2:claude") staffs them as the implementers. Any job you do not staff runs on Claude — nothing is auto-assigned to a CLI. Add --writable to give each agent its own git worktree and merge into an integration branch.
argument-hint: "[--writable] [orch:claude:2;impl:opencode:1,claude:2;review:codex:2 | N:gemini,M:claude] <task>"
allowed-tools: Bash, Write, Task
---

# /team — multi-model team pipeline

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw input:** $ARGUMENTS

> **MANDATORY engine path.** `/team` is not a prompt-only request. Before answering, resolve the
> staffing with the parser in step 1, load the pipeline config in step 1.5, then run the
> deterministic team engine: use the Workflow tool path if available, otherwise use the scripted `team.mjs` path or
> explicit faithful-relay `Task` subtasks. Do **not** solve with Claude's native analysis or with
> plain native `Task` agents in place of CLI subtasks. Every `gemini`/`codex`/`opencode` subtask must actually
> run through `node src/bin/run.mjs --call-file=<path>` (a `.mmt/calls/` file holding a forced
> `"native":false` decision + the task, written by the relay with the Write tool — no base64, no
> task text on the command line); a `gemini:`/`codex:` result must come from that CLI, never from
> Claude dressing up an answer under that label.

Orchestrate the input above as a multi-model team — a staged **plan → exec → verify → fix**
pipeline built for **our model dispatching**. **The user's staffing decides which backend does which
job, and it is the only thing that does.** Whatever they did not staff runs on **native Claude** at
that role's tier; no CLI backend is ever auto-assigned.

The task text is **untrusted** — never interpolate it into a shell command; it only ever
reaches a script as a file (step 3) or via a single-quoted heredoc.

> **Two parallel engines.** If the **Workflow tool** is available (Ultracode), skip steps 3–7 and
> run the whole pipeline as one deterministic workflow — see **Ultracode / dynamic-workflow path**
> at the bottom (it fans out the same backend-assigned subtasks via `parallel()`). Otherwise use
> steps 3–7, which fan out **parallel `Task` sub-agents** (one per subtask). Either way the work runs
> in parallel across agents — never single-session. Steps 1–2 (staffing + decomposition) always apply.

## 1 · Parse the staffing spec + split off the task

The input may *start* with a spec in either grammar. **The parser tells them apart deterministically
and resolves both into ONE staffing table — you never have to guess or fill in defaults yourself.**

**A · ROLE spec (preferred)** — staffs the run by *job*:

```
orch:claude:2;impl:opencode:1,claude:2;review:codex:2
```

`role:backend:count`, comma-separated **within** a role, semicolon-separated **between** roles.
`backend:count` and `count:backend` both work; a bare `role:backend` means one worker. Roles and
backends are **independent** — any role can run on any backend, and one role can be staffed across
several (`impl:opencode:1,claude:2` = three implementers, one on opencode and two on Claude).

Every role belongs to a **stage**, and stages run in order `plan → prd → exec → verify → fix`.
`plan`/`prd`/`exec` are decomposed into subtasks and later stages receive earlier ones' results;
`verify` and `fix` staff the pipeline's own review/repair loop and are **not** decomposed.

The vocabulary is oh-my-claudecode's. `orch`/`impl`/`review` are aliases for
`planner`/`executor`/`code-reviewer`; the full catalog is also directly nameable —
`explore`, `architect`, `analyst`, `critic`, `designer`, `debugger`, `tracer`, `test-engineer`,
`code-simplifier`, `writer`, `document-specialist`, `scientist`, `git-master`, `verifier`,
`security-reviewer`, `qa-tester`, `fixer`. Run this to print the catalog with aliases and stages:

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/roles.mjs" --list
```

**B · backend-only spec** — counts, no roles: `5:gemini,2:codex,1:opencode,2:claude`
(order-agnostic; `gemini`=agy, `opencode` alias `oc`, `claude`=native). Naming a backend without a
role means **"use it to do the work"**, so these become the **executors**.

**The three fallback rules** (applied by the parser, not by you):
1. any job nobody staffed runs on **Claude** at that role's tier — never on a CLI;
2. the **fixer follows the executor**, so a fix goes back to whoever did the work;
3. a job is staffed by *any* role on its stage — `review:codex:2` IS the review job, so no second
   Claude reviewer is added alongside it.

Let the parser split the spec off the task **deterministically**. Feed the **whole raw input** on a
single-quoted heredoc (the injection-safe boundary — never put the input on the command line):

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/team-spec.mjs" --split <<'MMT_ARGS_EOF'
<the entire raw input shown above>
MMT_ARGS_EOF
```

→ `{ "roles": {...}, "caps": {...}, "task": "<task stripped>", "source": "roles|spec|default",
"flags": ["--writable"], "writable": true|false }`.

Use **`.task`** as the task — it already has the spec **and** any leading `--flag` removed.

**Always pass the whole `.roles` object through as `args.roles`, whatever `.source` says** — it is
already resolved, including the Claude fallbacks. It carries:

- `assignments` — every `{role, stage, backend, count, tier, desc, source}`; `source` is `spec`
  (the user asked for it), `follows` (inherited, e.g. fixer from executor) or `default` (Claude).
- `workers` / `verifiers` / `fixers` — the same list split by job.
- `stages` (active worker stages, in order), `stageOrder`, `backends`, `counts`, `defaulted`.

`.caps` is projected off the worker staffing for the scripted path's `--gemini-cap`; there is no
separate cap mechanism. If `.roles.note` is non-empty, surface it — that is where an unknown role,
an unknown backend, or a **disabled** one is reported.

### Mode: read-only (default) vs `--writable`
The same parse decides the mode: use **`.writable`** from the step-1 output (true when the input
carried a leading `--writable`). Do **not** re-scan the raw input for the token — the parser already
consumed it and removed it from `.task`, and it accepts the flag on either side of the cap spec
(`--writable 3:gemini …` and `3:gemini --writable …` both work). `.writable` true → **writable
mode**; otherwise **read-only mode** (the default).

- **read-only (DEFAULT):** the CLI agents (agy/codex/opencode) stay **read-only** — they return text, not edits.
  Any file changes are applied by **you (the orchestrator) directly to the CURRENT branch**. Do **NOT**
  create a branch, a worktree, or a PR in this mode. This is the back-compat behaviour.
- **writable (`--writable`):** each subtask gets its **own git worktree + branch** off the current HEAD;
  the assigned agent (CLI **full-auto** via `run.mjs --cwd <worktree> --writable`, or a native solver
  writing in the worktree) makes **real file changes** there; then the orchestrator **cherry-picks every
  subtask's commit onto one integration branch `mmt/team-<slug>`** off HEAD (**no merge commits — one
  clean raw commit per subtask**, message scoped to the subtask label) and **resolves any conflicts
  itself** (reading both sides, editing to a correct combined result, folding the fix into that same raw
  commit) — so you get **one finished, conflict-free branch with a clean linear history**, not a pile of
  worktrees and no noisy `merge <label>` commits. (Only a conflict it
  genuinely can't reconcile is left `unresolved` for you.) Your current branch is **untouched** (no
  auto-merge onto it), and **no GitHub PR is created** — you merge/PR the integration branch when ready.

In the Ultracode path, pass `writable: true` in the Workflow args for writable mode (the workflow runs
the Setup → Dispatch → Integrate stages). In the Task-agent path, follow the writable steps marked
**(writable mode)** below; in read-only mode skip them and apply edits to the current branch directly.

## 1.5 · Load the pipeline config (and honor in-session overrides)
This is **pipeline tuning only** — it no longer picks backends (step 1's staffing does). Read the
merged config (roster `team` over built-in defaults); it never touches the task text, so it's safe
to run plainly:

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/config.mjs" team-config
```

→ `{ verify, max_fix_loops, relay_model, native_models }`. Pass it straight into the workflow as
`args.teamConfig`. If the user *describes* an override in-session — "no verification", "verify with
gemini", "try two fix rounds" — apply it as the matching top-level arg (`verify`, `verifier`,
`maxFixLoops`), which wins. **Precedence: built-in default < roster `team` < this invocation.**

## 2 · Decompose the task
Split the task into subtasks. **You may only use a (role, backend) pair that step 1 actually
staffed** (`args.roles.workers`), and at most that pair's `count` subtasks. A subtask naming an
unstaffed pair, or exceeding the count, is **dropped — never re-homed onto another backend.** For
**each** subtask decide:
- **role** — which staffed worker does it. The role's **stage** fixes when it runs, and its `desc`
  is handed to the worker as a brief, so pick the role whose job this subtask actually is.
- **backend** — one the role was staffed on. What each is good at, when you have a choice:
  - **agy** (Gemini CLI) — fast/cheap commodity & verifiable work and Gemini's edges: new
    components/CSS/UI, scaffolding, CRUD, scripts, SQL, regex, configs, unit tests, data
    transforms, web-research/doc-summary, audio/video.
  - **codex** (Codex CLI) — code review, writing/extending tests, verification, focused checkable
    code units.
  - **opencode** (OpenCode CLI) — runs on **whichever model the user configured in opencode
    itself** (the plugin passes no model flag): their own local/self-hosted model, or a provider
    the others don't cover.
  - **native** (Claude) — judgment / your-codebase context / hard-to-verify, **and the hard line**:
    RE, IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design.
- **deps** — the labels of any other subtasks whose output this one needs (it runs *after* them
  and gets their results as context). `[]` if independent. Keep the graph acyclic.
- **verify** — one short, checkable acceptance criterion (what makes the result correct).
- **tier** — carry the role's tier; the staffing corrects it anyway, so the role is what ultimately
  selects the model (per backend: `high` on agy means agy's strongest model, not Opus).

Do **not** emit subtasks for the verify or fix stages — those are the pipeline's own loop
(steps 5–6), staffed separately. If the user staffed the hard line onto a CLI, that is their
explicit choice and it stands.

## 3 · Write the plan (injection-safe)
Use the **Write tool** to write the plan JSON to **`.mmt/plans/plan.json`** (relative to the project
root — this plugin's own state directory; **do NOT write it under `.omc/`** even if oh-my-claudecode
is active, and do NOT scatter it elsewhere). It is an array of subtasks; include `deps`/`verify`
when relevant (the dispatcher ignores keys it doesn't use, so they're safe to carry):

```json
[
  {"label":"data-model","task":"<full text>","backend":"native","tier":"sonnet","deps":[],"verify":"schema covers users+orders with FKs"},
  {"label":"sql-report","task":"<full text>","backend":"agy","tier":"standard","deps":["data-model"],"verify":"valid Postgres, joins on the FK"}
]
```

Writing via the Write tool keeps every subtask as inert data. `.mmt/` is this plugin's state dir
(plans, scratch); it's gitignored, so the plan file is local-only.

## 4 · Dispatch each subtask as a PARALLEL Task agent (dependency-ordered waves)
This is the OMC-style fan-out **using our CLI dispatching**: every subtask becomes its own **`Task`
sub-agent**, and a whole **wave** is spawned **in ONE message** so the agents run in **parallel** —
do NOT solve subtasks inline and do NOT wait for one agent before spawning the next. A **wave** = the
subtasks whose `deps` are all already complete; run waves in order, feeding each finished result into
its dependents. Never exceed a staffed pair's worker count in flight at once. A plan
with no `deps` is a single wave — the common case.

There are two worker kinds:

- **CLI backend (agy / codex) → a FAITHFUL RELAY agent.** It does NOT solve the task; it runs our one
  dispatch command and returns the CLI's output verbatim (this is the no-dress-up contract — a
  `gemini:`/`codex:` result must come from that CLI, not from Claude). Spawn a Bash-capable agent
  (`subagent_type: "general-purpose"`, and **set `model` to the `relay_model` from step 1.5 — resolved
  from merged roster config; the shipped roster value is `haiku`, and the built-in fallback is `sonnet`**). A relay does ZERO reasoning (one Bash call, return stdout verbatim), so it must be
  pinned to the cheap relay model — do NOT let it inherit the orchestrator's model (e.g. Opus), or
  you pay Opus rates to shell out to a CLI. Use this prompt — substitute the real plugin root for
  `<PLUGIN_ROOT>`, the subtask's `<BE>` (agy|codex|opencode) and `<TIER>`, a short unique `<CALL_PATH>` like
  `.mmt/calls/<label>.json`, and the subtask text into the call file's `"task"` field — never the
  raw text on the command line:

  **File transport, not base64** (shell-agnostic — the relay's shell may be PowerShell, where a
  `<<'EOF'` heredoc is a parse error and single-quoted `'{...}'` JSON gets mangled). The relay writes
  the payload to a FILE with the Write tool (untrusted task text never touches a command line), then
  passes only the file PATH to run.mjs. The path is a safe `[A-Za-z0-9_/.-]` token, verbatim in any
  shell. The call file holds both the forced decision and the task:

  ````
  You are a FAITHFUL RELAY for the multi-model-team plugin — do NOT solve, analyze,
  or answer the task yourself.

  Step 1 — with the Write tool (NOT a shell command), write this JSON to "<CALL_PATH>". You MUST replace
  the `<the subtask text …>` placeholder with the ACTUAL subtask text (JSON-escaped, plus any
  `Upstream result — <dep>:` blocks) before writing — it is a placeholder, not literal content. The
  Write tool creates parent dirs:
  {"decision":{"backend":"<BE>","model":"","tier":"<TIER>","rule":"team","native":false},"task":"<the subtask text, with any Upstream result — <dep>: blocks appended>"}

  SELF-CHECK: after substitution the "task" value must be the real subtask text, NOT a `<...>`
  placeholder and NOT empty/undefined. If you cannot fill in the real task, STOP — do not write the
  file or run the command; report backend_ran:false with empty stdout. (run.mjs also rejects an
  unsubstituted placeholder, but never rely on that — substitute correctly.)

  Step 2 — run EXACTLY this one command with the Bash tool (only the file path is on the command line;
  the payload stays in the file, read only inside run.mjs by Node), then return its stdout VERBATIM
  with no preamble:

  node "<PLUGIN_ROOT>/src/bin/run.mjs" --call-file="<CALL_PATH>"

  CRITICAL — run it in the FOREGROUND and WAIT for it to finish. The <BE> CLI can legitimately take
  MANY MINUTES on a hard task; run.mjs blocks until it completes (its own generous timeout SIGKILLs
  the CLI on expiry). Do NOT background it (no `&`, no run_in_background), do NOT wrap it in your own
  sleep/timeout/tail -f, and do NOT give up early — a slow response is NOT a failure.

  If your Bash tool hits ITS OWN time limit before the command returns, do NOT immediately re-run it —
  re-running spawns a SECOND <BE> process while the first is still working (this is the multi-attempt
  thrash that wastes 10+ minutes and still fails). Instead CHECK "<CALL_PATH>.status.json" first:
  state:"running" → keep WAITING, re-read the status file (do NOT re-run the node command), it updates
  ~every 10s; state:"done" → report the stdout you already captured (run.mjs does NOT cache —
  re-running re-dispatches a fresh job, so prefer what you have); state:"failed" → return
  backend_ran:false; status missing or stale (elapsed_ms not advancing across two reads → run.mjs
  died) → re-run the command once. Re-run the node command at most ONCE; never loop it.

  If stdout begins with "MMT_NATIVE_HANDOFF" (the <BE> CLI was unavailable), return EXACTLY that
  sentinel line and nothing else — do not solve the task yourself. Otherwise return stdout as printed.
  ````

- **native → a SOLVER agent.** Spawn a sub-agent (model by tier: `sonnet` default, `opus` only for
  the hard line / deep architecture) with:

  ````
  Solve this subtask directly and return a complete, self-contained result — no
  preamble. <Append "Upstream result — <dep>:" blocks for each dep so it has that context.>

  SUBTASK: <subtask text>
  ````

**No dress-up on handoff:** if a relay agent returns a bare `MMT_NATIVE_HANDOFF` (its CLI was down),
spawn a **visible native solver agent** for that subtask instead — never let a `gemini:`/`codex:`
result be quietly produced by Claude. Track which backend **actually** ran each subtask for step 7.

> Scripted alternative (no agents): `node "${CLAUDE_PLUGIN_ROOT}/src/bin/team.mjs" --plan <wave.json>
> --gemini-cap G` runs a wave's CLI subtasks as parallel `run.mjs` subprocesses and lists the native
> ones. Use it for a non-interactive batch; the **Task-agent fan-out above is the default for `/team`**.

## 5 · Verify each result — on the staffed reviewer(s)
**Delegate the review to whoever staffs the verify stage** (`args.roles.verifiers` from step 1 —
the user's `review:codex:2` / `security:agy:1`, or the Claude fallback when they staffed nobody).
Give each reviewer its **role brief** (`desc`) so a `security-reviewer` audits for vulnerabilities
rather than doing a generic pass/fail. If several reviewers are staffed, a result must satisfy
**all** of them. For every subtask result, run each reviewer's backend through
`run.mjs` with a forced decision, feeding the review brief — the subtask, its `verify` criterion, and
the result. **Use the same file transport as the dispatch relay** (the verifier command may run under
PowerShell, where a heredoc + single-quoted JSON mangles and silently falls through to native): write
the decision + review brief to a call file with the Write tool, then pass only its path. Swap `codex`
below for the reviewer's staffed backend:

- `<VERIFY_CALL_PATH>` = a short unique path like `.mmt/calls/verify-<label>.json`, written with the
  Write tool, containing (substitute the REAL `<text>`/`<verify>`/`<result>` — JSON-escaped — never
  leave the placeholders unfilled):
  ```json
  {"decision":{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false},
   "task":"You are a strict reviewer. Reply with a first line of exactly PASS or FAIL, one sentence why, then (only if FAIL) a one-line fix instruction.\nSUBTASK: <text>   ACCEPTANCE CRITERION: <verify>   RESULT: <result>"}
  ```

```
node "${CLAUDE_PLUGIN_ROOT}/src/bin/run.mjs" --call-file="<VERIFY_CALL_PATH>"
```

Trust the verifier's PASS/FAIL verdict. Be skeptical of the result: incomplete, wrong, empty, or
"describes-instead-of-doing" results **fail**. A bare `MMT_NATIVE_HANDOFF` in the *subtask* result
(its CLI was unavailable) counts as a fail — solve it natively instead. If **the reviewer itself** is
unavailable (its stdout starts with `MMT_NATIVE_HANDOFF`), or it is staffed on `native`, verify with
your own native judgment.

## 6 · Fix failures in a bounded loop
For each failed subtask, re-dispatch it with the failure reason + a fix instruction + the previous
result appended. **Where it goes:** `args.roles.fixers`. A fixer with `source:"spec"` means the user
explicitly staffed the fix stage — send it there. Otherwise the fix goes back to the subtask's **own
backend** (whoever did the work). Re-verify. Cap this at **1 fix attempt per subtask** by default
(raise only if asked). After the cap, leave it marked **failed** — don't paper over it.

## 7 · Synthesize
Combine all verified results into one coherent answer to the original task. Note which backend
**actually** ran each part (a relay that handed off ran on native, not the CLI) and its verification
status; call out anything still failed.

---

## Ultracode / dynamic-workflow path
If you have the **Workflow tool** available (Ultracode reasoning on), prefer running the whole
pipeline as one deterministic workflow instead of steps 3–7:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/team.mjs",
  args: { task: "<the task text>",
          pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
          roles: <the WHOLE .roles object from step 1 — ALWAYS pass it, whatever .source said. It is
                  the resolved staffing: who does what, with the Claude fallbacks already applied>,
          teamConfig: <team-config JSON from step 1.5 — pipeline knobs only>,
          // optional top-level in-session overrides — these WIN over teamConfig (omit if none):
          verifier: "<any backend, or 'native'> — replaces the staffed reviewers for this run only",
          writable: <true ONLY if the user passed --writable; omit/false otherwise>,
          verify: true, maxFixLoops: 1 }
})
```

`team.mjs` decomposes the task (deps + verify criteria) **within the staffing**, dispatches each
subtask in dependency-ordered waves on its staffed backend (any non-native backend is relayed to its
CLI via `run.mjs`; native solves in-context), has the staffed reviewer(s) verify each result (a
visible native fallback if a reviewer CLI is unavailable), runs a bounded fix loop on failures, and
synthesizes. **Staffing is the only assignment mechanism** — omit `args.roles` and the workflow runs
the whole pipeline on Claude rather than auto-staffing CLIs. Read its returned
`{ plan, mode, backends, staffing:{workers,verifiers,fixers,defaulted}, counts:{byBackend,byRole,byStage,…},
verifier, writable, results, final }` and present `final`, noting `counts.failed` if non-zero. If
`staffing.defaulted` is non-empty, mention which jobs fell back to Claude because nobody staffed
them. **In writable mode** (`mode:"writable"`), also surface `writable.integration_branch` and
`writable.integration` — tell the user the changes are on that **finished, conflict-free** branch (their
current branch is untouched), note any `writable.integration.resolved` conflicts the orchestrator
reconciled (so they can review the resolution) and flag any `writable.integration.unresolved` ones that
still need their hand, and how to inspect it (`git log <integration_branch>`). (`args.task` is passed
as a JSON value, not shell — injection-safe.)

A trivial single task needs no fan-out: one subtask reduces this to a plain verified dispatch.
