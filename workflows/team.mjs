export const meta = {
  name: 'mmt-team',
  description: 'Model-dispatching team pipeline: decompose a task into backend-assigned subtasks, dispatch them dependency-aware (commodity → parallel agy/Gemini, judgment/hard-line → native Claude), verify each result, fix failures in a bounded loop, then synthesize.',
  phases: [
    { title: 'Decompose', detail: 'split into backend-assigned subtasks with deps + verify criteria' },
    { title: 'Dispatch', detail: 'dependency-ordered waves: agy via run.sh + native in parallel' },
    { title: 'Verify', detail: 'score each result against its acceptance criterion' },
    { title: 'Fix', detail: 'bounded re-dispatch of failed subtasks with verifier feedback' },
    { title: 'Synthesize', detail: 'merge verified results into one answer' },
  ],
}

// =============================================================================
// mmt-team — a staged model-dispatch pipeline: plan -> exec -> verify -> fix loop,
// with per-subtask provider routing and stage handoffs. The "provider per role" is
// our agy(Gemini)-vs-native(Claude) backend split, resolved per subtask at plan time.
//
// Determinism: this script runs under the Workflow runtime, which forbids
// Date/random APIs (they break resume). Nothing here uses them. Vary-by-index is
// used wherever uniqueness is needed.
// Injection-safety: agy subtasks ride to run.sh on a single-quoted heredoc, so the
// (untrusted) subtask text is inert data and never parsed by a shell.
// =============================================================================

// ---- inputs (from Workflow args) -------------------------------------------
// Tolerate args arriving as an object OR a JSON string (callers vary).
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}
const task = A.task || ''
const capsIn = A.caps || {}
const root = A.pluginRoot || ''
const G = Math.max(0, Math.min(16, Number(capsIn.gemini ?? 4) || 0))
const C = Math.max(0, Math.min(16, Number(capsIn.claude ?? 2) || 0))
// Verify is ON by default (the whole point of the verify stage);
// callers can disable it or tune the bounded fix loop.
const VERIFY = A.verify === false ? false : true
const MAX_FIX = Math.max(0, Math.min(3, Number(A.maxFixLoops ?? 1) || 0))
// The Verify stage runs on the codex CLI by default (codex is scoped to code review /
// tests / verification — see config/roster.json agents.codex). `verifier:'native'` or
// `codexVerify:false` keeps verification on native Claude instead. If codex is unavailable
// at runtime, the relay falls back to native judgment loudly (same contract as agy dispatch).
const VERIFIER = (A.verifier === 'native' || A.codexVerify === false) ? 'native' : 'codex'

if (!task || !String(task).trim()) {
  return { error: 'mmt-team: no task provided in args.task' }
}
if (!root) {
  return { error: 'mmt-team: args.pluginRoot is required to locate scripts/run.sh' }
}
if (G + C === 0) {
  return { error: 'mmt-team: caps sum to 0 — no agents available to dispatch' }
}

const RUN = `${root}/scripts/run.sh`

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'short kebab name, unique within the plan' },
          task: { type: 'string', description: 'full self-contained subtask text' },
          backend: { type: 'string', enum: ['agy', 'native'] },
          tier: { type: 'string', enum: ['cheap', 'standard', 'sonnet', 'opus'] },
          deps: {
            type: 'array',
            description: 'labels of subtasks whose results this one consumes (run after them). [] if independent.',
            items: { type: 'string' },
          },
          verify: {
            type: 'string',
            description: 'one-line, checkable acceptance criterion for this subtask (used by the verify stage).',
          },
        },
        required: ['label', 'task', 'backend', 'tier'],
      },
    },
  },
  required: ['subtasks'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean', description: 'true if the result satisfies the acceptance criterion' },
    reason: { type: 'string', description: 'one sentence: why it passed or failed' },
    fix_hint: { type: 'string', description: 'if failing, a concrete instruction to fix it; else empty' },
  },
  required: ['pass', 'reason'],
}

// ---- 1 · Decompose ----------------------------------------------------------
phase('Decompose')
const plan = await agent(
`Decompose this task into independent subtasks for a multi-model team, assign each a backend, and wire up dependencies + an acceptance criterion.

Backend rules (this is the model-dispatch contract):
- "agy"  = commodity / verifiable / Gemini-edge work: new components, CSS/UI, scaffolding, CRUD, scripts, SQL, regex, configs, unit tests, data transforms, web-research / doc-summary, audio/video. tier = "standard" (or "cheap" for tiny/bulk).
- "native" = judgment / codebase-context / hard-to-verify work, AND the hard line — RE, IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design — which must NEVER be "agy". Pick the tier BY COMPLEXITY, do NOT default to opus: "sonnet" is the default for ordinary codebase analysis, understanding, reviews, and standard logic; reserve "opus" ONLY for genuinely hard work — the hard line above, deep cross-system architecture, or subtle concurrency/perf reasoning. A routine "analyze/understand this code" subtask is "sonnet", not "opus".

For each subtask also provide:
- "deps": the labels of any OTHER subtasks whose output this one needs. Those run first and their results are handed to this subtask. Use [] when independent. Keep the dependency graph acyclic.
- "verify": one short, checkable acceptance criterion (what makes this subtask's result correct).

Use AT MOST ${G} agy subtasks and AT MOST ${C} native subtasks. Prefer fewer, well-scoped subtasks; a trivial task is a single subtask. Labels must be unique. Each subtask's "task" must be self-contained.

TASK:
${task}`,
  { label: 'decompose', phase: 'Decompose', schema: PLAN_SCHEMA }
)

// ---- normalize + resolve the routing snapshot (resolved once) ---------------
let raw = ((plan && plan.subtasks) || []).filter((s) => s && s.task && String(s.task).trim())

// Coerce tier per backend so a forced agy decision never carries a tier run.sh can't map.
for (const s of raw) {
  s.backend = s.backend === 'agy' ? 'agy' : 'native'
  if (s.backend === 'agy') s.tier = s.tier === 'cheap' ? 'cheap' : 'standard'
  else s.tier = s.tier === 'opus' ? 'opus' : 'sonnet'
}

// Make labels unique + safe (deps reference labels, so collisions would be ambiguous).
const seen = new Set()
raw.forEach((s, i) => {
  let base = String(s.label || `task${i}`).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `task${i}`
  let lab = base
  let n = 2
  while (seen.has(lab)) { lab = `${base}-${n}`; n++ }
  seen.add(lab)
  s.label = lab
})

// Apply per-backend caps (the loud, deterministic part of model dispatching).
const agyAll = raw.filter((s) => s.backend === 'agy')
const natAll = raw.filter((s) => s.backend !== 'agy')
const kept = [...agyAll.slice(0, G), ...natAll.slice(0, C)]
if (agyAll.length > G) log(`dropping ${agyAll.length - G} agy subtask(s) over cap ${G}`)
if (natAll.length > C) log(`dropping ${natAll.length - C} native subtask(s) over cap ${C}`)

// Graceful fallback: if nothing survived the caps, run the whole task as one subtask
// on whichever backend still has capacity (prefer native for an unscoped ask).
if (kept.length === 0) {
  log('no subtasks survived caps — collapsing to a single subtask')
  if (C > 0) kept.push({ label: 'task', task, backend: 'native', tier: 'sonnet', deps: [], verify: '' })
  else kept.push({ label: 'task', task, backend: 'agy', tier: 'standard', deps: [], verify: '' })
}

// Sanitize deps: keep only edges that point at a surviving label; drop self-edges.
const keptLabels = new Set(kept.map((s) => s.label))
for (const s of kept) {
  const d = Array.isArray(s.deps) ? s.deps : []
  s.deps = [...new Set(d.map(String))].filter((l) => l !== s.label && keptLabels.has(l))
  s.verify = typeof s.verify === 'string' ? s.verify : ''
}

log(`plan: ${kept.filter((s) => s.backend === 'agy').length} agy + ${kept.filter((s) => s.backend !== 'agy').length} native (caps ${G}/${C}); verify=${VERIFY ? VERIFIER : 'off'} maxFix=${MAX_FIX}`)

// ---- dispatch primitives ----------------------------------------------------
// Map a plan tier to a concrete model so the plan's COMPLEXITY call actually takes effect.
// Without an explicit model, every agent here inherits the main-loop model (e.g. Opus 4.8) —
// which is exactly why native codebase-analysis used to run on Opus regardless of tier. So:
//   cheap / standard / sonnet -> "sonnet"  (commodity + ordinary judgment/analysis)
//   opus                      -> "opus"    (only the genuinely hard line, per decompose)
// This is what makes the team's model choice "dynamic by complexity" rather than always-Opus.
function tierModel(tier) {
  return tier === 'opus' ? 'opus' : 'sonnet'
}

// An agy subtask is RELAYED to the local agy CLI through run.sh (forced decision so
// routing matches the plan). The relay agent returns run.sh's stdout verbatim; only
// on a native-handoff sentinel (agy unavailable/exhausted) does it solve in-context —
// this is our "loud fallback when a provider CLI is missing". Label prefixed `gemini:` so the
// progress tree shows which CLI ran it; the relay itself is cheap (sonnet), agy does the work.
function dispatchAgy(text, tier, label, ph) {
  return agent(
`You are a relay — do NOT solve the subtask yourself unless told to. Delegate it to the agy (Gemini) backend and return ONLY its output.

Run exactly this with the Bash tool — the subtask rides in on a single-quoted heredoc, so it is inert data and is never parsed by the shell (if the subtask happens to contain the line MMT_SUB_EOF, pick a different unique delimiter):

bash ${JSON.stringify(RUN)} --decision '{"backend":"agy","model":"","tier":"${tier}","rule":"team","native":false}' <<'MMT_SUB_EOF'
${text}
MMT_SUB_EOF

Return the command's stdout verbatim. If it begins with "MMT_NATIVE_HANDOFF" (agy was unavailable), THEN solve the subtask yourself and return that result instead.`,
    { label: `gemini:${label}`, phase: ph || 'Dispatch', model: 'sonnet' }
  )
}

function dispatchNative(text, tier, label, ph) {
  return agent(
`Solve this subtask directly and return a complete, self-contained result:\n\n${text}`,
    { label: `native:${label}`, phase: ph || 'Dispatch', model: tierModel(tier) }
  )
}

function dispatch(s, text, ph) {
  return s.backend === 'agy'
    ? dispatchAgy(text, s.tier || 'standard', s.label, ph)
    : dispatchNative(text, s.tier || 'sonnet', s.label, ph)
}

// Stage-handoff: a dependent subtask is given its upstream deps' verified results as
// context (carry concrete upstream outputs forward between stages).
function withContext(s, ctx) {
  const deps = (s.deps || []).filter((l) => ctx[l] != null)
  if (!deps.length) return s.task
  const blocks = deps.map((l) => `### Upstream result — ${l}\n${ctx[l]}`).join('\n\n')
  return `${s.task}\n\n--- CONTEXT FROM UPSTREAM SUBTASKS (already completed) ---\n${blocks}`
}

// ---- verify -----------------------------------------------------------------
// The Verify stage is delegated to the codex CLI (scoped to code review / tests /
// verification) by default. A native relay agent runs codex through run.sh to review the
// result against its acceptance criterion, then packages codex's PASS/FAIL verdict into the
// structured shape. If codex is unavailable (handoff sentinel) the relay reviews it itself
// with native judgment — a loud fallback, same contract as the agy dispatch path. The
// `verifier:'native'` knob skips codex entirely and verifies on native Claude.
async function verifyResult(s, result) {
  if (!VERIFY) return { pass: true, reason: 'verify disabled', fix_hint: '' }
  const handoff = typeof result === 'string' && result.indexOf('MMT_NATIVE_HANDOFF') === 0
  const criterion = s.verify && s.verify.trim()
    ? s.verify.trim()
    : 'The result fully and correctly satisfies the subtask.'

  if (VERIFIER === 'codex') {
    // Codex does the review; the relay (native) reports its verdict in the required shape.
    // The review brief rides to run.sh on a single-quoted heredoc, so the (untrusted)
    // subtask + result text is inert data and is never parsed by a shell.
    const v = await agent(
`You are the verification relay for a multi-model team. Delegate the REVIEW to the codex (OpenAI Codex CLI) backend — it is scoped to code review / tests / verification — then report ITS verdict in the required structured form. Do NOT judge the result yourself unless codex is unavailable.

Run exactly this with the Bash tool (if the brief happens to contain the line MMT_VERIFY_EOF, pick a different unique delimiter):

bash ${JSON.stringify(RUN)} --decision '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}' <<'MMT_VERIFY_EOF'
You are a strict reviewer. Decide whether the RESULT satisfies the ACCEPTANCE CRITERION for the subtask below. Be skeptical: if it is incomplete, wrong, empty, or only describes what should be done instead of doing it, it FAILS. Answer with a first line of exactly PASS or FAIL, then one sentence of reasoning, then (only if FAIL) a concrete one-line fix instruction.

SUBTASK (${s.backend}/${s.tier}, label "${s.label}"):
${s.task}

ACCEPTANCE CRITERION:
${criterion}

RESULT:
${result}
MMT_VERIFY_EOF

Read codex's stdout and emit the structured verdict reflecting it: pass=true only if codex concluded PASS; copy codex's reasoning into reason and its fix instruction (if any) into fix_hint.${handoff ? ' Note: the subtask result was a native-handoff sentinel — treat it as a failure regardless of what codex says.' : ''} If codex's stdout begins with "MMT_NATIVE_HANDOFF" (codex unavailable/exhausted), THEN review the result yourself with strict native judgment and emit your own verdict instead.`,
      { label: `codex:verify:${s.label}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: tierModel(s.tier) }
    )
    return v || { pass: true, reason: 'verifier returned nothing; accepting', fix_hint: '' }
  }

  // Native verifier (knob: verifier:'native' / codexVerify:false).
  const v = await agent(
`You are a strict verifier (native Claude judgment). Decide whether the RESULT satisfies the acceptance criterion for this subtask. Be skeptical: if it is incomplete, wrong, empty, or only describes what should be done instead of doing it, fail it.${handoff ? ' (Note: the backend reported it was unavailable — treat a bare handoff sentinel as a failure.)' : ''}

SUBTASK (${s.backend}/${s.tier}, label "${s.label}"):
${s.task}

ACCEPTANCE CRITERION:
${criterion}

RESULT:
${result}`,
    { label: `native:verify:${s.label}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: tierModel(s.tier) }
  )
  return v || { pass: true, reason: 'verifier returned nothing; accepting', fix_hint: '' }
}

// ---- one subtask, end to end: dispatch -> verify -> bounded fix loop ---------
async function runSubtask(s, ctx) {
  const text = withContext(s, ctx)
  let result = await dispatch(s, text)
  let verdict = await verifyResult(s, result)
  let attempts = 1
  while (VERIFY && verdict && verdict.pass === false && attempts <= MAX_FIX) {
    log(`fix ${attempts}/${MAX_FIX} — ${s.label}: ${verdict.reason || 'failed verify'}`)
    const fixText =
`${text}

--- PREVIOUS ATTEMPT FAILED VERIFICATION ---
Reason: ${verdict.reason || '(none)'}
Fix instruction: ${verdict.fix_hint || 'Address the reason above and produce a correct, complete result.'}

Previous result:
${result}

Produce a corrected, complete result.`
    result = await dispatch({ ...s, label: `${s.label}#fix${attempts}` }, fixText, 'Fix')
    verdict = await verifyResult(s, result)
    attempts++
  }
  const status = !VERIFY ? 'unverified' : verdict && verdict.pass ? 'verified' : 'failed'
  return { label: s.label, backend: s.backend, tier: s.tier, deps: s.deps || [], attempts, status, verdict, result }
}

// ---- 2 · Dispatch in dependency-ordered waves -------------------------------
// A wave = the set of subtasks whose deps are all complete. Each wave runs in
// parallel (a barrier is correct here: a dependent cannot start before its dep
// finishes). This is the dependency-aware exec stage.
phase('Dispatch')
const ctx = {}            // label -> final result text (fed to dependents)
const records = []
let remaining = kept.slice()
let guard = 0
while (remaining.length && guard++ < kept.length + 2) {
  let ready = remaining.filter((s) => (s.deps || []).every((l) => ctx[l] != null))
  if (!ready.length) {
    // Unsatisfiable deps (cycle, or dep dropped by caps): break the deadlock by
    // running what's left without waiting — loudly, so it's visible.
    log(`dependency deadlock on ${remaining.map((s) => s.label).join(', ')} — dispatching without waiting`)
    ready = remaining.slice()
  }
  const waveRecords = (await parallel(ready.map((s) => () => runSubtask(s, ctx)))).filter(Boolean)
  for (const r of waveRecords) {
    ctx[r.label] = r.result
    records.push(r)
  }
  const done = new Set(waveRecords.map((r) => r.label))
  remaining = remaining.filter((s) => !done.has(s.label))
}

const failed = records.filter((r) => r.status === 'failed')
if (failed.length) log(`${failed.length} subtask(s) still failing after ${MAX_FIX} fix attempt(s): ${failed.map((r) => r.label).join(', ')}`)

// ---- 3 · Synthesize ---------------------------------------------------------
phase('Synthesize')
const final = await agent(
`Synthesize these verified subtask results into one coherent, complete answer to the original task.
Reconcile overlaps, resolve conflicts, and note which parts ran on Gemini (agy) vs native Claude, and the verification status of each. If any subtask is marked "failed", call that out explicitly rather than papering over it.

ORIGINAL TASK:
${task}

SUBTASK RESULTS (JSON):
${JSON.stringify(records, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  task,
  caps: { gemini: G, claude: C },
  verify: VERIFY,
  verifier: VERIFY ? VERIFIER : 'off',
  maxFixLoops: MAX_FIX,
  plan: kept.map((s) => ({ label: s.label, backend: s.backend, tier: s.tier, deps: s.deps || [], verify: s.verify || '' })),
  counts: {
    agy: kept.filter((s) => s.backend === 'agy').length,
    native: kept.filter((s) => s.backend !== 'agy').length,
    verified: records.filter((r) => r.status === 'verified').length,
    failed: failed.length,
  },
  results: records,
  final,
}
