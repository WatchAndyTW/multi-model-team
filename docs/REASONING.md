# /reasoning — multi-model parallel reasoning (OpenRouter Fusion-like)

This is the **design contract** for the `/reasoning` command. It mirrors OpenRouter's
**Fusion** model: fan the *same* question out to a **panel** of models in parallel, have a
**judge** compare their answers into a structured analysis, then have a **synthesizer** produce
one unified answer that is better than any single model's.

Fusion's pipeline (grounding):
1. **Parallel dispatch** — the prompt goes to every model in the panel simultaneously.
2. **Judge** — compares the panel's responses and returns structured analysis:
   *consensus* (points most models agree on → higher confidence), *contradictions*,
   *unique insights* (from a single model), *blind spots* (what none addressed).
3. **Synthesis** — a synthesis model writes a new unified answer incorporating the best of all.

This plugin maps that onto its existing backends: a panelist is a `(backend, tier)` pair —
native Claude (opus/sonnet/haiku), `agy` (Gemini), or `codex`. Native panelists run as real
sub-agents pinned to a model; CLI panelists run through the faithful `run.mjs` relay. The judge
and synthesizer default to native Opus.

---

## Files (who builds what)

| File | New/edit | Owner |
|---|---|---|
| `src/lib/reason-spec.mjs` | new | panel-spec parser |
| `src/lib/config.mjs` | edit — add `reasoningConfig()` + CLI mode | config loader |
| `src/bin/reason.mjs` | new | scripted panel fan-out engine |
| `workflows/reasoning.mjs` | new | Ultracode Fusion workflow |
| `commands/reasoning.md` | new | slash-command orchestration |
| `config/roster.json` | edit — add `reasoning` section | config |
| `test/reason.test.mjs` | new | unit tests |
| `README.md`, `CLAUDE.md` | edit — docs | docs |

Keep the house style: Node ESM `.mjs`, **zero runtime deps** (Node stdlib only), injection-safe
(untrusted question text never touches a shell argument — it rides on stdin / a single-quoted
heredoc / a JSON `args` value), determinism-safe in the workflow (no `Date`/`Math.random`).

---

## Panel token vocabulary (canonical — every component must agree)

A **panel token** is a short name a user types. It expands to a panelist `{ backend, tier }`:

| token (aliases) | → backend | → tier |
|---|---|---|
| `opus` | `native` | `opus` |
| `sonnet`, `claude`, `native`, `anthropic` | `native` | `sonnet` |
| `haiku` | `native` | `haiku` |
| `gemini`, `agy`, `pro`, `google` | `agy` | `standard` |
| `flash` | `agy` | `cheap` |
| `codex`, `openai`, `gpt`, `chatgpt` | `codex` | `standard` |

A token may be repeated for self-consistency, and a **count prefix** adds N copies:
`3:gemini` = three Gemini panelists; `gemini:3` is also accepted. Unknown tokens are ignored
with a note. Tier on a native panelist resolves to a concrete model via `tier_models`
(`opus→opus`, `sonnet→sonnet`, `haiku→haiku`, `cheap→haiku`, `standard→sonnet`).

**Default panel** (no spec given): the user's configured `reasoning.panel` in `config/roster.json`
(default `["opus", "sonnet", "gemini"]`). Edit that array to change which models participate by
default — e.g. `["opus","sonnet","gemini","codex"]` for a 4-model panel, or `["gemini","codex"]`
for a CLI-only panel. The per-invocation spec always overrides the roster panel.

---

## roster.json — new `reasoning` section

```json
"reasoning": {
  "_comment": "Roles + defaults for the /reasoning Fusion pipeline. 'panel' = default panelist tokens (each runs the SAME question in parallel); see docs/REASONING.md for the token vocabulary. 'judge' compares the panel into structured analysis; 'synthesizer' writes the unified answer (both 'native:<tier>' or a bare tier/backend token). 'cap' bounds total panelists. 'tier_models' maps a tier to a concrete native model; 'relay_model' is the model the thin CLI-relay agents run on. Overridable per-invocation (panel spec like '2:gemini,opus,codex', or 'judge with sonnet').",
  "panel": ["opus", "sonnet", "gemini"],
  "judge": "native:opus",
  "synthesizer": "native:opus",
  "cap": 6,
  "tier_models": { "cheap": "haiku", "standard": "sonnet", "sonnet": "sonnet", "opus": "opus", "haiku": "haiku" },
  "relay_model": "sonnet"
}
```

---

## `src/lib/config.mjs` — `reasoningConfig(roster)`

Add a `REASONING_DEFAULTS` const and an exported `reasoningConfig(roster)` that merges the roster
`reasoning` section over the defaults exactly like `teamConfig()` (deep-merge `tier_models`
key-by-key; `panel` replaced wholesale if present; ignore `_`-prefixed keys). Defaults:

```js
const REASONING_DEFAULTS = {
  panel: ['opus', 'sonnet', 'gemini'],
  judge: 'native:opus',
  synthesizer: 'native:opus',
  cap: 6,
  tier_models: { cheap: 'haiku', standard: 'sonnet', sonnet: 'sonnet', opus: 'opus', haiku: 'haiku' },
  relay_model: 'sonnet',
};
```

Also extend the CLI entry block: add a `reasoning-config` mode (alongside `team-config`) that
prints `JSON.stringify(reasoningConfig(roster))`. Do not change any existing export.

---

## `src/lib/reason-spec.mjs` — panel-spec parser (pure, zero-dep)

Exports:

- **`expandPanel(tokens, opts?)`** → `{ panel: Panelist[], note: string }`
  Expand an array of panel tokens (strings, each possibly `N:token` / `token:N`) into resolved
  panelists. `Panelist = { backend: 'native'|'agy'|'codex', tier: string, label: string, token: string }`.
  Labels are unique (`gemini`, `gemini-2`, …). Clamp the total to `opts.cap` (default 8, ceiling 16).
  Unknown tokens are skipped and described in `note`. If nothing valid expands, return an empty
  panel (caller falls back to its default).

- **`parsePanel(spec, opts?)`** → `{ panel: Panelist[], source: 'spec'|'default', note: string }`
  `spec` is a comma-separated token string (`"2:gemini,opus,codex"`). Empty/garbage → use
  `opts.defaultPanel` (token array, default `['opus','sonnet','gemini']`), `source:'default'`.
  Otherwise expand the spec tokens, `source:'spec'`. Respect `opts.cap`.

- **`splitPanel(rawText, opts?)`** → `{ panel, question, source }`
  Deterministically peel a **leading** panel spec off `rawText` (mirror `team-spec.splitSpec`):
  a leading run of comma-separated panel tokens / `N:token` pairs followed by whitespace + the
  question is treated as a spec; otherwise the whole text is the question and the default panel is
  used. `"why is the sky blue"` is NOT a spec; `"2:gemini,opus  why is the sky blue"` is.

- **CLI entry** (when run directly): read stdin; with `--split` print `splitPanel(stdin)`,
  else print `parsePanel(stdin.trim())`; JSON to stdout. Mirror `team-spec.mjs`'s CLI block,
  including honoring a `--default <comma,tokens>` flag to override the default panel (the command
  passes the roster default in).

Reuse the alias/clamp/`_reEscape` patterns from `team-spec.mjs`. `MAX_PER_PANEL = 16`.

---

## `src/bin/reason.mjs` — scripted panel fan-out engine

The Fusion **panel** stage as a no-agents script (sibling of `team.mjs`). Usage:

```
node reason.mjs --panel '<json Panelist[]>' [--cap N]          # question on stdin
node reason.mjs --panel-spec '2:gemini,codex' [--cap N]        # parsed via reason-spec + roster default
```

- Question is read from **stdin** (injection-safe). `--panel` takes a resolved `Panelist[]` JSON
  (preferred — the command passes this). `--panel-spec` is a convenience that parses via
  `reason-spec.parsePanel` using the roster `reasoning.panel` default (load via
  `config.reasoningConfig`). If both absent, use the roster default panel.
- Partition panelists: **CLI** (`agy`/`codex`) vs **native**.
- Run every CLI panelist **in parallel** (concurrency pool, cap default = roster `reasoning.cap`,
  ceiling 16) via `run.mjs --decision '{"backend":<be>,"model":"","tier":<tier>,"rule":"reason","native":false}'`,
  feeding the **same** question to each on stdin (spawn with `stdio:['pipe','pipe','pipe']`, write
  the question, end stdin). Reuse `team.mjs`'s `runParallel` pool + `errTail` helpers.
- Output (parity-styled with `team.mjs`):
  ```
  ===MMT-REASON panel: <C> cli (cap=N), <V> native ===

  --- PANELIST <BE> [<label>] (<backend>/<tier>) ---
  <verbatim stdout, or the MMT_NATIVE_HANDOFF block>

  --- PANELIST native [<label>] (native/<tier>) — answer in-context ---
  <the question text>

  ===MMT-REASON end ===
  ```
  A CLI panelist whose stdout begins with `MMT_NATIVE_HANDOFF` is shown as a handoff (its CLI was
  unavailable). Native panelists are **listed** for in-context answering (the script can't run
  Claude as a subprocess — true per-model native parallelism is the workflow's job). Each native
  panelist block carries its requested tier so the caller answers at that level.
- Standard `--help`, fail-closed on bad `--panel` JSON (error to stderr, exit 2). No external deps.

---

## `workflows/reasoning.mjs` — Ultracode Fusion workflow (the real thing)

`export const meta` with `name: 'mmt-reasoning'`, phases `Panel`, `Judge`, `Synthesize`. Mirror
`workflows/team.mjs` conventions (tolerate `args` as object or JSON string; determinism-safe;
self-contained — **inline** the panel-token alias map, do not import project libs).

Args: `{ question, pluginRoot, panel?, judge?, synthesizer?, reasoningConfig?, cap? }`.
- Resolve config: built-in default < `args.reasoningConfig` (roster) < top-level args.
- Resolve panel: `args.panel` (token array OR resolved `Panelist[]`) > `reasoningConfig.panel` >
  `['opus','sonnet','gemini']`. Expand tokens with the inlined map; clamp to `cap`.
- `judge` / `synthesizer`: `"native:opus"` or a bare tier/token → resolve to a model via
  `tier_models`. Default both to `opus`.

Pipeline:
1. **Panel** (`phase('Panel')`): one agent per panelist, all in parallel (`parallel(...)`). The
   SAME `question` goes to each.
   - native panelist → `agent(question, { model: tierModel(tier), label: 'native:'+label, phase:'Panel' })`.
   - CLI panelist → faithful relay through `run.mjs` (copy `dispatchRelay` + `RELAY_SCHEMA` from
     `team.mjs`, `rule:'reason'`). If `backend_ran` is false → **visible native fallback** agent
     (never a Claude answer wearing a CLI label). Record `ranOn`.
   Each yields `{ label, backend, ranOn, tier, answer }`.
2. **Judge** (`phase('Judge')`): one agent at the judge model, `schema: JUDGE_SCHEMA`:
   ```
   { consensus: string[], contradictions: string[], unique_insights: string[], blind_spots: string[], notes?: string }
   ```
   Given the question + every panelist's answer (labelled with which model produced it).
3. **Synthesize** (`phase('Synthesize')`): one agent at the synthesizer model. Given the question,
   all panel answers, and the judge analysis → produce the single best unified answer. Prefer
   consensus, fold in unique insights, address blind spots, resolve contradictions explicitly.

Return:
```js
{
  question, panel: [{label, backend, tier}], judge: <analysis>, synthesizer: <model>,
  counts: { byBackend, ranOn, nativeFallbacks }, panelists: [{label, backend, ranOn, answer}],
  final: <unified answer>
}
```

---

## `commands/reasoning.md` — slash command

Frontmatter: `description`, `argument-hint: "[panel-spec] <question>"`, `allowed-tools: Bash, Task`.
Plugin root `${CLAUDE_PLUGIN_ROOT}`; raw input `$ARGUMENTS`. Untrusted-input warning like team.md.
Mirror team.md's **two-engine** structure:

1. **Load reasoning config** (FIRST — gives the user's configured panel):
   `node "${CLAUDE_PLUGIN_ROOT}/src/lib/config.mjs" "${CLAUDE_PLUGIN_ROOT}/config/roster.json" reasoning-config`
   → `{ panel, judge, synthesizer, cap, tier_models, relay_model }`; apply any in-session override
   the user described ("judge with sonnet", "panel of gemini and codex only", "no synthesis just show the takes").
2. **Parse the panel spec** (peel a leading spec; pass the **user's configured panel** from step 1
   as `--default`, comma-joined):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/src/lib/reason-spec.mjs" --split --default <comma-joined step-1 .panel> <<'MMT_ARGS_EOF'
   <entire raw input>
   MMT_ARGS_EOF
   ```
   → `{ panel, question, source }`. Use `.question` as the question. `.panel` is the roster panel
   when `source:"default"`, or the per-invocation spec when `source:"spec"`. Either way `.panel` is authoritative.
3. **Ultracode path** — if the **Workflow tool** is available, run the whole Fusion pipeline:
   ```
   Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/reasoning.mjs",
     args: { question, pluginRoot, panel: <resolved .panel from step 2>,
             reasoningConfig: <from step 1>,
             judge: "<override?>", synthesizer: "<override?>", cap: <override?> } })
   ```
   Present `final`, then a short panel/judge appendix (who said what, the consensus / contradictions
   / unique insights / blind spots), and note any `counts.nativeFallbacks`.
4. **Fallback path** (no Workflow tool):
   - **Panel** — spawn every panelist as its **own parallel `Task` agent in ONE message**
     (`[mmt-team-worker]`-tagged so the spawn guard exempts them). Native panelist → a SOLVER agent
     pinned to the model for its tier (opus/sonnet/haiku), answering the question directly. CLI
     panelist → a FAITHFUL RELAY agent (the exact relay prompt from team.md, `rule:"reason"`) that
     runs `node src/bin/run.mjs --decision '{...,"native":false}'` with the question on a
     single-quoted heredoc and returns stdout verbatim; a bare `MMT_NATIVE_HANDOFF` → re-dispatch
     that panelist as a visible native solver. (Or, for a non-interactive batch, the scripted
     `reason.mjs --panel <json>` with the question on stdin.)
   - **Judge** — natively (or on the configured judge backend) produce the structured analysis
     (consensus / contradictions / unique insights / blind spots) over the panel answers.
   - **Synthesize** — produce the unified final answer, then show the panel/judge appendix.

A single-panelist run degenerates to one answer with no judge/synthesis — fine.

---

## Tests (`test/reason.test.mjs`)

`node --test` style, importing modules directly (see `test/helpers.mjs`, `test/team.test.mjs`):

- `expandPanel`: token→panelist mapping for every alias; `3:gemini` count prefix; unique labels;
  cap clamp; unknown token skipped + noted.
- `parsePanel`: spec parses; empty/garbage → default panel + `source:'default'`; cap respected.
- `splitPanel`: leading spec peeled (`"2:gemini,opus build X".question === 'build X'`); a plain
  question is NOT misread as a spec; default panel applied when no spec.
- `config.reasoningConfig`: defaults present; roster `reasoning` overrides merge (deep-merge
  `tier_models`); `_`-keys ignored.

Keep the existing suite green; the project counts total passing tests in the README — update that
number when you add tests.
