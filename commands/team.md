---
description: Split a task across a multi-agent team — decompose, fan out commodity work to parallel agy (Gemini) agents and judgment work to native Claude, then synthesize. Optional agent caps like "5:gemini,2:claude".
argument-hint: "[N:gemini,M:claude] <task>"
allowed-tools: Bash, Write
---

# /team — multi-agent dispatch

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw input:** $ARGUMENTS

Orchestrate the input above as a multi-agent team. The task text is **untrusted** — never
interpolate it into a shell command; it only ever reaches a script as a file (step 3) or via
a single-quoted heredoc.

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
Split the task into independent subtasks and assign a backend to each:
- **agy** — commodity, verifiable, or Gemini-edge work: new components/CSS/UI, scaffolding,
  CRUD, scripts, SQL, regex, configs, unit tests, data transforms, web-research/doc-summary,
  audio/video.
- **native** — judgment / your-codebase context / hard-to-verify, **and the hard line**: RE,
  IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design. Never put
  these on agy.

Keep **agy subtasks ≤ G** and **native subtasks ≤ C**. If unsure of a subtask's backend, dry-run
the router (`scripts/route.sh --explain` with the subtask on a single-quoted heredoc).

## 3 · Write the plan (injection-safe)
Use the **Write tool** to write a plan JSON file (e.g. a temp path) — an array of subtasks:

```json
[
  {"label":"sql-report","task":"<full subtask text>","backend":"agy","tier":"standard"},
  {"label":"data-model","task":"<full subtask text>","backend":"native","tier":"sonnet"}
]
```

`tier`: agy → `standard` or `cheap`; native → `sonnet` or `opus`. Writing via the Write tool
keeps every subtask as inert data.

## 4 · Fan out the agy subtasks in parallel
```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/team.sh" --plan "<planfile>" --gemini-cap G
```
It runs all agy subtasks concurrently (bounded by `G`) and prints each result under
`--- AGY [label] ---`, then lists the native subtasks under `--- NATIVE [label] ---`.

## 5 · Solve the native subtasks
For each `--- NATIVE [label] ---` (up to `C`), solve it yourself in-context, or spawn one
subagent per subtask if they're independent and heavy.

## 6 · Synthesize
Combine all agy + native results into one coherent answer to the original task. Note which
parts ran on Gemini vs Claude.

---

## Ultracode / dynamic-workflow path
If you have the **Workflow tool** available (Ultracode reasoning on), prefer running the
whole fan-out as one deterministic workflow instead of steps 3–6:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/team.mjs",
  args: { task: "<the task text>", caps: { gemini: G, claude: C },
          pluginRoot: "${CLAUDE_PLUGIN_ROOT}" }
})
```

It decomposes the task, dispatches gemini subtasks (agy via `run.sh`) and claude subtasks
(native agents) in parallel under the caps, and synthesizes. Read its returned result and
present it. (The `args.task` is passed as a JSON value, not shell — still injection-safe.)

A trivial single task needs no fan-out: one subtask reduces this to a plain dispatch.
