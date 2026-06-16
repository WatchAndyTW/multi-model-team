---
description: Run a question through the multi-model Fusion pipeline — fan it out to a configurable panel of models in parallel (default panel is the user-configurable set from `reasoning.panel` in roster.json, defaulting to Opus+Sonnet+Gemini; override per-invocation with a spec like "2:gemini,opus,codex"), have a judge compare their answers into structured analysis (consensus / contradictions / unique insights / blind spots), then synthesize one unified answer that is better than any single model's.
argument-hint: "[panel-spec] <question>"
allowed-tools: Bash, Task
---

# /reasoning — multi-model parallel reasoning (Fusion)

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw input:** $ARGUMENTS

Fan the question out to every panelist **in parallel**, judge the results into structured
analysis, then synthesize a single unified answer that folds in the best of each model.

The question text is **untrusted** — never interpolate it into a shell command; it only ever
reaches a script as a single-quoted heredoc or a JSON `args` value.

> **Two parallel engines.** If the **Workflow tool** is available (Ultracode), skip to the
> **Ultracode / dynamic-workflow path** at the bottom — it runs the full Fusion pipeline
> (`Panel → Judge → Synthesize`) as one deterministic workflow. Otherwise use steps 3–4,
> which fan out **parallel `Task` sub-agents** (one per panelist) then judge and synthesize
> natively. Either way the panel runs in parallel. Steps 1–2 (config load + spec parsing) always apply.

## 1 · Load the reasoning config (and honor in-session overrides)

The pipeline's roles are **config-driven**. Read the merged reasoning config (roster `reasoning`
over built-in defaults) **first** — this gives you the user's configured panel, judge, synthesizer,
cap, and tier_models. This never touches the question text, so it is safe to run plainly:

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/config.mjs" "${CLAUDE_PLUGIN_ROOT}/config/roster.json" reasoning-config
```

→ `{ panel, judge, synthesizer, cap, tier_models, relay_model }` — the **user's configured defaults**.
If the user *describes* an override in-session — e.g. "judge with sonnet", "panel of gemini and
codex only", "no synthesis just show the takes", "cap at 3" — apply it on top. **Precedence:
built-in default < roster `reasoning` < this invocation.**

## 2 · Parse the optional panel spec + split off the question

The input may *start* with a panel spec — a comma list of panel tokens / `N:token` pairs such as
`2:gemini,opus,codex` (each token expands to a `{backend, tier}` panelist; a count prefix adds N
copies). Let the parser split it off **deterministically**, passing the **user's configured panel**
(from step 1) as the default. Feed the **whole raw input** on a single-quoted heredoc (the
injection-safe boundary — never put the input on the command line). The `--default` value is the
controlled config token list (comma-joined from step 1 `.panel`), never the question:

```
node "${CLAUDE_PLUGIN_ROOT}/src/lib/reason-spec.mjs" --split --default <comma-joined reasoning-config .panel from step 1> <<'MMT_ARGS_EOF'
<the entire raw input shown above>
MMT_ARGS_EOF
```

For example, if the roster `reasoning.panel` is `["opus","sonnet","gemini"]`, pass `--default opus,sonnet,gemini`.
If the user has configured `["gemini","codex"]`, pass `--default gemini,codex`.

→ `{ "panel": [...], "question": "<question stripped>", "source": "spec|default", "note": "..." }`.
Use **`.question`** as the question. If `.note` is non-empty, surface it.
- `source:"default"` — no spec was given; `.panel` is the user's roster panel (from step 1).
- `source:"spec"` — user typed a spec; `.panel` is that explicit per-invocation override.

Either way, use `.panel` from the parser as the resolved panel going forward.

## 3 · Ultracode / dynamic-workflow path

If you have the **Workflow tool** available (Ultracode reasoning on), run the whole Fusion pipeline
as one deterministic workflow instead of step 4:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/reasoning.mjs",
  args: {
    question: "<the question text — passed as a JSON value, injection-safe>",
    pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
    panel: <resolved .panel token array from step 2 — always pass it; it is the roster panel on default, the spec on spec>,
    reasoningConfig: <reasoning-config JSON from step 1>,
    // optional in-session overrides — these WIN over reasoningConfig (omit if none):
    judge: "<override?>",
    synthesizer: "<override?>",
    cap: <N?>
  }
})
```

`reasoning.mjs` fans the question out to every panelist in parallel (native panelists as real
sub-agents pinned to their model, CLI panelists via the faithful `run.mjs` relay with
`rule:"reason"`; a CLI that returns `MMT_NATIVE_HANDOFF` becomes a visible native fallback agent —
never a Claude answer wearing a CLI label). The judge model then compares all answers into a
structured analysis; the synthesizer model writes the unified answer. Read the returned
`{ question, panel, judge, synthesizer, counts, panelists, final }` and present:

1. **Final answer** (`final`).
2. **Panel / judge appendix** — who said what (each `panelists[i].answer` labelled with
   `label` + `ranOn`), then the judge's `consensus` / `contradictions` / `unique_insights` /
   `blind_spots`.
3. Note any `counts.nativeFallbacks` if non-zero (a CLI was unavailable).

## 4 · Fallback path (no Workflow tool)

### Panel — parallel Task agents (one per panelist, spawned in ONE message)

Every panelist from `.panel` (step 2) becomes its **own `Task` sub-agent** launched in parallel
in one message. Every worker prompt is tagged **`[mmt-team-worker]`** so the spawn-guard hook
leaves them alone.

**Native panelist** (backend `native`, tier `opus` / `sonnet` / `haiku`) — spawn a SOLVER agent
pinned to the model for its tier (resolve via `tier_models` from step 1: `opus→opus`,
`sonnet→sonnet`, `haiku→haiku`, `cheap→haiku`, `standard→sonnet`):

```
[mmt-team-worker] Answer the following question directly and completely at the <TIER> level.
Return only your answer — no preamble.

QUESTION:
<question text>
```

**CLI panelist** (backend `agy` or `codex`) — spawn a FAITHFUL RELAY agent (`subagent_type:
"general-purpose"`, and **set `model` to the `relay_model` from step 1 — `haiku` by default**). A
relay does ZERO reasoning (one Bash call, return stdout verbatim), so pin it to the cheap relay
model — do NOT let it inherit the orchestrator's model (e.g. Opus). It does NOT solve the question;
it runs the one dispatch command and returns stdout verbatim. Substitute the real plugin root for
`<PLUGIN_ROOT>`, the backend `<BE>` (agy|codex), and `<TIER>`:

```
[mmt-team-worker] You are a FAITHFUL RELAY for the multi-model-team plugin — do NOT solve,
analyze, or answer the question yourself. Run EXACTLY this one command with the Bash tool
(the question rides in on a single-quoted heredoc — inert data, never parsed by the shell;
if it contains the line MMT_SUB_EOF, change the delimiter), then return its stdout VERBATIM
with no preamble:

node "<PLUGIN_ROOT>/src/bin/run.mjs" --decision '{"backend":"<BE>","model":"","tier":"<TIER>","rule":"reason","native":false}' <<'MMT_SUB_EOF'
<question text>
MMT_SUB_EOF

If stdout begins with "MMT_NATIVE_HANDOFF" (the <BE> CLI was unavailable), return EXACTLY that
sentinel line and nothing else — do not answer the question yourself.
```

**No dress-up on handoff:** if a relay returns a bare `MMT_NATIVE_HANDOFF`, spawn a **visible
native solver agent** for that panelist instead — never let a `gemini:`/`codex:` result be quietly
produced by Claude. Track which backend **actually** answered each question (`ranOn`).

Alternatively, for a non-interactive batch, run the scripted panel fan-out:
`node "${CLAUDE_PLUGIN_ROOT}/src/bin/reason.mjs" --panel '<Panelist[] JSON>'` with the question on stdin.

### Judge — structured analysis

With all panel answers collected, run natively (or on the configured judge backend) to produce:

```json
{
  "consensus": ["points most panelists agreed on — higher confidence"],
  "contradictions": ["points where panelists disagreed"],
  "unique_insights": ["valuable point from only one panelist"],
  "blind_spots": ["important angles none of the panelists addressed"]
}
```

Present each panelist's answer labelled with which model/backend produced it, then the structured
analysis above.

### Synthesize

Using the question, all panel answers, and the judge's analysis, produce the single best unified
answer: prefer consensus, fold in unique insights, address blind spots explicitly, resolve
contradictions. Then show the panel/judge appendix.

A single-panelist run degenerates to one answer with no judge/synthesis — fine.
