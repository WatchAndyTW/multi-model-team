---
description: Run a task through the multi-model team pipeline — decompose into backend-assigned subtasks (commodity → parallel agy/Gemini, judgment/hard-line → native Claude), dispatch dependency-aware, verify each result, fix failures in a bounded loop, then synthesize. Optional caps like "5:gemini,2:claude".
argument-hint: "[N:gemini,M:claude] <task>"
allowed-tools: Bash, Write, Task
---

# /team — multi-model team pipeline

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw input:** $ARGUMENTS

Orchestrate the input above as a multi-model team — a staged **plan → exec → verify → fix**
pipeline built for **our model dispatching**: the "provider per role" is **native Claude** for
planning/synthesis, **agy (Gemini)** for commodity subtask dispatch, and **codex** for verifying
each result — chosen per stage/subtask.

The task text is **untrusted** — never interpolate it into a shell command; it only ever
reaches a script as a file (step 3) or via a single-quoted heredoc.

> **Two parallel engines.** If the **Workflow tool** is available (Ultracode), skip steps 3–7 and
> run the whole pipeline as one deterministic workflow — see **Ultracode / dynamic-workflow path**
> at the bottom (it fans out the same backend-assigned subtasks via `parallel()`). Otherwise use
> steps 3–7, which fan out **parallel `Task` sub-agents** (one per subtask). Either way the work runs
> in parallel across agents — never single-session. Steps 1–2 (cap parsing + decomposition) always apply.

## 1 · Parse the optional agent-cap spec + split off the task
The input may *start* with a cap spec — a comma list of `N:<backend>` pairs such as
`5:gemini,2:codex,1:claude` (order-agnostic; `gemini`=agy, `codex`=codex, `claude`=native — all
equal). Let the parser split it off **deterministically**. Feed the **whole raw input** on a
single-quoted heredoc (the injection-safe boundary — never put the input on the command line):

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/team-spec.mjs" --split <<'MMT_ARGS_EOF'
<the entire raw input shown above>
MMT_ARGS_EOF
```

→ `{ "gemini": G, "codex": K, "claude": C, "source": "spec|default", "task": "<task stripped>",
"note": "..." }`. Use **`.task`** as the task. The caps bound parallel agents per backend
(`gemini`=agy, `codex`=codex, `claude`=native). **Only pass these as `args.caps` when `.source` is
`"spec"`** (the user actually typed a spec); on `"default"`, omit caps so the roster `team.caps`
applies. If `.note` is non-empty, surface it.

## 1.5 · Load the team roles config (and honor in-session overrides)
The pipeline's roles are **config-driven**, not hardcoded. Read the merged team config (roster
`team` over built-in defaults) — this never touches the task text, so it's safe to run plainly:

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/config.mjs" "${CLAUDE_PLUGIN_ROOT}/config/roster.json" team-config
```

→ `{ dispatch_backends, verifier, verify, max_fix_loops, caps, tier_models, relay_model }` — the
**defaults**. **native, agy and codex are EQUAL** — any can be assigned to any subtask and any can be
the verifier. If the user *describes* a role override in-session — e.g. "verify with gemini", "only
use codex and native", "no verification", "verify on opus" — apply it on top. **Precedence: built-in
default < roster `team` < this invocation.** Pass the config straight into the workflow as
`args.teamConfig`, and any in-session override as the matching top-level arg (`verifier`, `caps`, …)
which wins. `verifier:"native"` = review on Claude (no CLI).

## 2 · Decompose the task
Split the task into subtasks. For **each** subtask decide four things:
- **backend** — pick the **best-fit** from the eligible set (`dispatch_backends`, default
  `agy`/`codex`/`native` — all equal options):
  - **agy** (Gemini CLI) — fast/cheap commodity & verifiable work and Gemini's edges: new
    components/CSS/UI, scaffolding, CRUD, scripts, SQL, regex, configs, unit tests, data
    transforms, web-research/doc-summary, audio/video.
  - **codex** (Codex CLI) — code review, writing/extending tests, verification, focused checkable
    code units.
  - **native** (Claude) — judgment / your-codebase context / hard-to-verify, **and the hard line**:
    RE, IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design. The hard
    line **must stay native**.
- **deps** — the labels of any other subtasks whose output this one needs (it runs *after* them
  and gets their results as context). `[]` if independent. Keep the graph acyclic.
- **verify** — one short, checkable acceptance criterion (what makes the result correct).
- **tier** — CLI backends (agy/codex) → `standard`/`cheap`; native → **by complexity**: `sonnet`
  for ordinary codebase analysis / understanding / reviews / standard logic (the default), `opus`
  ONLY for the hard line or deep architecture / subtle concurrency. Do NOT default analysis to
  `opus`. (In the Ultracode path the tier maps to the actual model, so this keeps the native model
  cost-adaptive.)

Respect the **per-backend caps** (≤ the cap for each backend). If unsure of a subtask's backend,
dry-run the router (`src/bin/route.mjs --explain` with the subtask on a single-quoted heredoc).

## 3 · Write the plan (injection-safe)
Use the **Write tool** to write a plan JSON file — an array of subtasks. Include `deps`/`verify`
when relevant (the dispatcher ignores keys it doesn't use, so they're safe to carry):

```json
[
  {"label":"data-model","task":"<full text>","backend":"native","tier":"sonnet","deps":[],"verify":"schema covers users+orders with FKs"},
  {"label":"sql-report","task":"<full text>","backend":"agy","tier":"standard","deps":["data-model"],"verify":"valid Postgres, joins on the FK"}
]
```

Writing via the Write tool keeps every subtask as inert data.

## 4 · Dispatch each subtask as a PARALLEL Task agent (dependency-ordered waves)
This is the OMC-style fan-out **using our CLI dispatching**: every subtask becomes its own **`Task`
sub-agent**, and a whole **wave** is spawned **in ONE message** so the agents run in **parallel** —
do NOT solve subtasks inline and do NOT wait for one agent before spawning the next. A **wave** = the
subtasks whose `deps` are all already complete; run waves in order, feeding each finished result into
its dependents. Respect the per-backend caps (≤ the cap for each backend in flight at once). A plan
with no `deps` is a single wave — the common case.

Every worker prompt is tagged **`[mmt-team-worker]`** so the spawn-guard hook leaves our own workers
alone. There are two worker kinds:

- **CLI backend (agy / codex) → a FAITHFUL RELAY agent.** It does NOT solve the task; it runs our one
  dispatch command and returns the CLI's output verbatim (this is the no-dress-up contract — a
  `gemini:`/`codex:` result must come from that CLI, not from Claude). Spawn a Bash-capable agent
  (e.g. `subagent_type: "general-purpose"`) with this prompt — substitute the real plugin root for
  `<PLUGIN_ROOT>`, the subtask's `<BE>` (agy|codex) and `<TIER>`, the subtask text, and any upstream
  dep results:

  ````
  [mmt-team-worker] You are a FAITHFUL RELAY for the multi-model-team plugin — do NOT solve, analyze,
  or answer the task yourself. Run EXACTLY this one command with the Bash tool (the subtask rides in
  on a single-quoted heredoc — inert data, never parsed by the shell; if it contains the line
  MMT_SUB_EOF, change the delimiter), then return its stdout VERBATIM with no preamble:

  node "<PLUGIN_ROOT>/src/bin/run.mjs" --decision '{"backend":"<BE>","model":"","tier":"<TIER>","rule":"team","native":false}' <<'MMT_SUB_EOF'
  <subtask text — with any "Upstream result — <dep>:" blocks appended>
  MMT_SUB_EOF

  If stdout begins with "MMT_NATIVE_HANDOFF" (the <BE> CLI was unavailable), return EXACTLY that
  sentinel line and nothing else — do not solve the task yourself. Otherwise return stdout as printed.
  ````

- **native → a SOLVER agent.** Spawn a sub-agent (model by tier: `sonnet` default, `opus` only for
  the hard line / deep architecture) with:

  ````
  [mmt-team-worker] Solve this subtask directly and return a complete, self-contained result — no
  preamble. <Append "Upstream result — <dep>:" blocks for each dep so it has that context.>

  SUBTASK: <subtask text>
  ````

**No dress-up on handoff:** if a relay agent returns a bare `MMT_NATIVE_HANDOFF` (its CLI was down),
spawn a **visible native solver agent** for that subtask instead — never let a `gemini:`/`codex:`
result be quietly produced by Claude. Track which backend **actually** ran each subtask for step 7.

> Scripted alternative (no agents): `node "${CLAUDE_PLUGIN_ROOT}/src/bin/team.mjs" --plan <wave.json>
> --gemini-cap G` runs a wave's CLI subtasks as parallel `run.mjs` subprocesses and lists the native
> ones. Use it for a non-interactive batch; the **Task-agent fan-out above is the default for `/team`**.

## 5 · Verify each result — on the configured verifier
**Delegate the review to the configured `verifier` backend** (`team.verifier`, default codex — any
backend, or `native` for Claude judgment). For every subtask result, run that backend through
`run.sh` with a forced decision, feeding the review brief — the subtask, its `verify` criterion, and
the result — on a single-quoted heredoc so it stays inert data (swap `codex` below for the configured
verifier):

```
node "${CLAUDE_PLUGIN_ROOT}/src/bin/run.mjs" --decision '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}' <<'MMT_VERIFY_EOF'
You are a strict reviewer. Reply with a first line of exactly PASS or FAIL, one sentence why, then (only if FAIL) a one-line fix instruction.
SUBTASK: <text>   ACCEPTANCE CRITERION: <verify>   RESULT: <result>
MMT_VERIFY_EOF
```

Trust the verifier's PASS/FAIL verdict. Be skeptical of the result: incomplete, wrong, empty, or
"describes-instead-of-doing" results **fail**. A bare `MMT_NATIVE_HANDOFF` in the *subtask* result
(its CLI was unavailable) counts as a fail — solve it natively instead. If **the verifier itself** is
unavailable (its stdout starts with `MMT_NATIVE_HANDOFF`), or `verifier` is `native`, verify with
your own native judgment.

## 6 · Fix failures in a bounded loop
For each failed subtask, re-dispatch it (a fresh Task agent on the **same backend**) with the failure
reason + a fix instruction + the previous result appended. Re-verify. Cap this at **1 fix attempt per
subtask** by default (raise only if asked). After the cap, leave it marked **failed** — don't paper over it.

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
          teamConfig: <team-config JSON from step 1.5 — edit .dispatch_backends/.verifier/.caps to override roles>,
          // optional top-level in-session overrides — these WIN over teamConfig (omit if none):
          caps: <{ gemini, codex, claude } ONLY if the cap spec source=="spec">,
          verifier: "<any backend, or 'native'>",
          verify: true, maxFixLoops: 1 }
})
```

`team.mjs` decomposes the task (deps + verify criteria), dispatches each subtask in dependency-ordered
waves **on its assigned backend** (any non-native backend is relayed to its CLI via `run.sh`; native
solves in-context), verifies each result on the configured **verifier** backend (native Claude falls
back if it's unavailable), runs a bounded fix loop on failures, and synthesizes. Roles come from
`args.teamConfig` (the roster `team` section): `dispatch_backends` (the equal set), `verifier`
(`"native"` = Claude judgment), `caps`, `tier_models`, `verify`, `max_fix_loops`. Per-invocation args
override (`verifier`, `caps`, `verify`, `maxFixLoops`). With no `teamConfig`, the built-in defaults
apply (all three backends eligible; codex verify). Read its returned `{ plan, backends, caps,
counts:{byBackend,…}, verifier, results, final }` and present `final`, noting `counts.failed` if
non-zero. (`args.task` is passed as a JSON value, not shell — injection-safe.)

A trivial single task needs no fan-out: one subtask reduces this to a plain verified dispatch.
