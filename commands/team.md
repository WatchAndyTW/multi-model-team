---
description: Run a task through the multi-model team pipeline — decompose into backend-assigned subtasks (commodity → parallel agy/Gemini, judgment/hard-line → native Claude), dispatch dependency-aware, verify each result, fix failures in a bounded loop, then synthesize. Optional caps like "5:gemini,2:claude".
argument-hint: "[N:gemini,M:claude] <task>"
allowed-tools: Bash, Write
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

> **Prefer the Ultracode path.** If the **Workflow tool** is available, skip steps 3–8 and run
> the whole pipeline as one deterministic workflow — see **Ultracode / dynamic-workflow path**
> at the bottom. Steps 1–2 (cap parsing + decomposition) still apply.

## 1 · Parse the optional agent-cap spec + split off the task
The input may *start* with a cap spec — a comma list of `N:<backend>` pairs such as
`5:gemini,2:codex,1:claude` (order-agnostic; `gemini`=agy, `codex`=codex, `claude`=native — all
equal). Let the parser split it off **deterministically**. Feed the **whole raw input** on a
single-quoted heredoc (the injection-safe boundary — never put the input on the command line):

```
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/lib/team_spec.py" --split <<'MMT_ARGS_EOF'
<the entire raw input shown above>
MMT_ARGS_EOF
```

→ `{ "gemini": G, "codex": K, "claude": C, "source": "spec|default", "task": "<task stripped>",
"note": "..." }`. Use **`.task`** as the task. The caps bound parallel agents per backend
(`gemini`=agy, `codex`=codex, `claude`=native). **Only pass these as `args.caps` when `.source` is
`"spec"`** (the user actually typed a spec); on `"default"`, omit caps so the roster `team.caps`
applies. If `.note` is non-empty, surface it. (`team_spec.py` is **Python** — call it with `python3`.)

## 1.5 · Load the team roles config (and honor in-session overrides)
The pipeline's roles are **config-driven**, not hardcoded. Read the merged team config (roster
`team` over built-in defaults) — this never touches the task text, so it's safe to run plainly:

```
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.py" "${CLAUDE_PLUGIN_ROOT}/config/roster.json" team-config
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
dry-run the router (`scripts/route.sh --explain` with the subtask on a single-quoted heredoc).

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

## 4 · Dispatch the CLI-backend subtasks in dependency-ordered waves
Run a **wave** at a time: CLI-backend subtasks (agy, codex, …) whose `deps` are all already
satisfied. For each wave, write a sub-plan containing that wave's non-`native` subtasks and fan it out:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/team.sh" --plan "<wave-plan.json>" --gemini-cap G
```

`team.sh` runs that wave concurrently (bounded by `--gemini-cap`) and prints each result under
`--- <BACKEND> [label] ---` (e.g. `--- AGY [...]`, `--- CODEX [...]`) using each subtask's own
backend, then lists native subtasks under `--- NATIVE [label] ---`. When a wave's results are in,
feed them as context into dependents. A plan with no `deps` is a single wave — the common case.

## 5 · Solve the native subtasks (respecting deps)
For each `--- NATIVE [label] ---` (up to `C`), solve it yourself in-context — after its `deps`
are done, passing those upstream results in. Spawn one subagent per subtask if they're
independent and heavy.

## 6 · Verify each result — on the configured verifier
**Delegate the review to the configured `verifier` backend** (`team.verifier`, default codex — any
backend, or `native` for Claude judgment). For every subtask result, run that backend through
`run.sh` with a forced decision, feeding the review brief — the subtask, its `verify` criterion, and
the result — on a single-quoted heredoc so it stays inert data (swap `codex` below for the configured
verifier):

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" --decision '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}' <<'MMT_VERIFY_EOF'
You are a strict reviewer. Reply with a first line of exactly PASS or FAIL, one sentence why, then (only if FAIL) a one-line fix instruction.
SUBTASK: <text>   ACCEPTANCE CRITERION: <verify>   RESULT: <result>
MMT_VERIFY_EOF
```

Trust the verifier's PASS/FAIL verdict. Be skeptical of the result: incomplete, wrong, empty, or
"describes-instead-of-doing" results **fail**. A bare `MMT_NATIVE_HANDOFF` in the *subtask* result
(its CLI was unavailable) counts as a fail — solve it natively instead. If **the verifier itself** is
unavailable (its stdout starts with `MMT_NATIVE_HANDOFF`), or `verifier` is `native`, verify with
your own native judgment.

## 7 · Fix failures in a bounded loop
For each failed subtask, re-dispatch it to the **same backend** with the failure reason + a fix
instruction + the previous result appended. Re-verify. Cap this at **1 fix attempt per subtask**
by default (raise only if asked). After the cap, leave it marked **failed** — do not paper over it.

## 8 · Synthesize
Combine all verified results into one coherent answer to the original task. Note which backend ran
each part and its verification status; call out anything still failed.

---

## Ultracode / dynamic-workflow path
If you have the **Workflow tool** available (Ultracode reasoning on), prefer running the whole
pipeline as one deterministic workflow instead of steps 3–8:

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
