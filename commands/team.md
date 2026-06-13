---
description: Run a task through the multi-model team pipeline — decompose into backend-assigned subtasks (commodity → parallel agy/Gemini, judgment/hard-line → native Claude), dispatch dependency-aware, verify each result, fix failures in a bounded loop, then synthesize. Optional caps like "5:gemini,2:claude".
argument-hint: "[N:gemini,M:claude] <task>"
allowed-tools: Bash, Write
---

# /team — multi-model team pipeline

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw input:** $ARGUMENTS

Orchestrate the input above as a multi-model team — a staged **plan → exec → verify → fix**
pipeline built for **our model dispatching**: the "provider per role" is our **agy (Gemini)**
vs **native (Claude)** split, chosen per subtask.

The task text is **untrusted** — never interpolate it into a shell command; it only ever
reaches a script as a file (step 3) or via a single-quoted heredoc.

> **Prefer the Ultracode path.** If the **Workflow tool** is available, skip steps 3–8 and run
> the whole pipeline as one deterministic workflow — see **Ultracode / dynamic-workflow path**
> at the bottom. Steps 1–2 (cap parsing + decomposition) still apply.

## 1 · Parse the optional agent-cap spec + split off the task
The input may *start* with a cap spec — a comma list of `N:gemini`/`N:claude` pairs such as
`5:gemini,2:claude` (order-agnostic; `gemini`=agy, `claude`=native). Let the parser split it
off **deterministically**. Feed the **whole raw input** on a single-quoted heredoc (this is the
injection-safe boundary — never put the input on the command line):

```
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/lib/team_spec.py" --split <<'MMT_ARGS_EOF'
<the entire raw input shown above>
MMT_ARGS_EOF
```

→ `{ "gemini": G, "claude": C, "task": "<task with the spec stripped>", "note": "..." }`.
Use **`.task`** as the task to decompose. `gemini` caps parallel agy delegations; `claude` caps
native subagents; no spec → sensible defaults. If `.note` is non-empty, surface it to the user
(a pair was dropped/ignored). (Note: `team_spec.py` is **Python** — call it with `python3`, not
`bash`.)

## 2 · Decompose the task
Split the task into subtasks. For **each** subtask decide four things:
- **backend**:
  - **agy** — commodity, verifiable, or Gemini-edge work: new components/CSS/UI, scaffolding,
    CRUD, scripts, SQL, regex, configs, unit tests, data transforms, web-research/doc-summary,
    audio/video.
  - **native** — judgment / your-codebase context / hard-to-verify, **and the hard line**: RE,
    IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design. Never agy.
- **deps** — the labels of any other subtasks whose output this one needs (it runs *after* them
  and gets their results as context). `[]` if independent. Keep the graph acyclic.
- **verify** — one short, checkable acceptance criterion (what makes the result correct).
- **tier** — agy → `standard`/`cheap`; native → `sonnet`/`opus`.

Keep **agy subtasks ≤ G** and **native subtasks ≤ C**. If unsure of a subtask's backend, dry-run
the router (`scripts/route.sh --explain` with the subtask on a single-quoted heredoc).

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

## 4 · Dispatch the agy subtasks in dependency-ordered waves
Run a **wave** at a time: agy subtasks whose `deps` are all already satisfied. For each wave,
write a sub-plan containing only that wave's `backend:"agy"` subtasks and fan it out:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/team.sh" --plan "<wave-plan.json>" --gemini-cap G
```

`team.sh` runs that wave concurrently (bounded by `G`) and prints each result under
`--- AGY [label] ---`, then lists native subtasks under `--- NATIVE [label] ---`. When a wave's
agy results are in, feed them as context into the next wave's subtask text (and into native
subtasks that depend on them). A plan with no `deps` is a single wave — the common case.

## 5 · Solve the native subtasks (respecting deps)
For each `--- NATIVE [label] ---` (up to `C`), solve it yourself in-context — after its `deps`
are done, passing those upstream results in. Spawn one subagent per subtask if they're
independent and heavy.

## 6 · Verify each result
For every subtask result (agy and native), check it against that subtask's `verify` criterion.
Be skeptical: incomplete, wrong, empty, or "describes-instead-of-doing" results **fail**. A bare
`MMT_NATIVE_HANDOFF` (agy was unavailable) counts as a fail — solve it natively instead.

## 7 · Fix failures in a bounded loop
For each failed subtask, re-dispatch it to the **same backend** with the failure reason + a fix
instruction + the previous result appended. Re-verify. Cap this at **1 fix attempt per subtask**
by default (raise only if asked). After the cap, leave it marked **failed** — do not paper over it.

## 8 · Synthesize
Combine all verified results into one coherent answer to the original task. Note which parts ran
on Gemini (agy) vs native Claude and each part's verification status; call out anything still failed.

---

## Ultracode / dynamic-workflow path
If you have the **Workflow tool** available (Ultracode reasoning on), prefer running the whole
pipeline as one deterministic workflow instead of steps 3–8:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/team.mjs",
  args: { task: "<the task text>", caps: { gemini: G, claude: C },
          pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
          verify: true, maxFixLoops: 1 }
})
```

`team.mjs` decomposes the task (deps + verify criteria), dispatches in dependency-ordered waves
(agy subtasks via `run.sh`, native subtasks as agents), verifies each result, runs a bounded fix
loop on failures, and synthesizes. `verify` (default `true`) and `maxFixLoops` (default `1`, max
`3`) are optional knobs. Read its returned `{ plan, counts, results, final }` and present `final`,
noting `counts.failed` if non-zero. (`args.task` is passed as a JSON value, not shell — injection-safe.)

A trivial single task needs no fan-out: one subtask reduces this to a plain verified dispatch.
