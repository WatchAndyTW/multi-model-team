export const meta = {
  name: 'mmt-team',
  description: 'Model-dispatching team pipeline: decompose a task into subtasks and assign each to the best-fit backend (agy / codex / native — all equal, configurable), dispatch dependency-aware, verify each result on the configured verifier, fix failures in a bounded loop, then synthesize.',
  phases: [
    { title: 'Decompose', detail: 'split into backend-assigned subtasks with deps + verify criteria' },
    { title: 'Dispatch', detail: 'dependency-ordered waves: each subtask on its assigned backend (CLI relay or native)' },
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
const root = A.pluginRoot || ''

// ---- team config: WHICH backend plays each role is configurable, not hardcoded -------------
// The shipped defaults (agy/Gemini front-end + codex verify) are just defaults. The roster
// `team` section (passed in as args.teamConfig — the Workflow runtime can't read files itself)
// overrides them, and per-invocation args (in-session override) override the roster. Precedence:
//   built-in default  <  args.teamConfig (roster)  <  top-level A.* (this invocation).
const TC = (A.teamConfig && typeof A.teamConfig === 'object') ? A.teamConfig : {}
const RELAY_MODEL = A.relayModel || TC.relay_model || 'sonnet'          // model the thin relay agents run on
const TIER_MODELS = { cheap: 'haiku', standard: 'sonnet', sonnet: 'sonnet', opus: 'opus', ...(TC.tier_models || {}) }

// Backends are EQUAL, interchangeable tools. Any of them (incl. native Claude) can be assigned to
// any subtask by the decompose, and any can be the verifier — none is pinned to "simple work" or
// "verify only". `dispatch_backends` is the eligible set the decompose chooses from (native is
// always kept as the judgment/hard-line option). Per-backend caps bound parallelism.
const KNOWN = ['agy', 'codex', 'native']
let DISPATCH = (Array.isArray(TC.dispatch_backends) && TC.dispatch_backends.length
  ? TC.dispatch_backends.map(String) : ['agy', 'codex', 'native']).filter((b) => KNOWN.includes(b))
if (!DISPATCH.includes('native')) DISPATCH.push('native')   // native is always available (safe default)
DISPATCH = [...new Set(DISPATCH)]

// Per-backend caps = max parallel subtasks on that backend. Precedence low->high:
//   built-in default  <  roster team.caps (by backend name)  <  cap spec (A.caps: gemini/codex/claude).
const CAP_DEFAULT = { agy: 4, codex: 2, native: 2 }
const SPEC_CAPS = A.caps || {}        // from the cap spec: { gemini, codex, claude }
const ROSTER_CAPS = TC.caps || {}     // by backend name: { agy, codex, native }
const CAP_ALIAS = { agy: 'gemini', native: 'claude', codex: 'codex' }   // backend -> cap-spec key
const CAPS = {}
for (const b of DISPATCH) {
  const v = SPEC_CAPS[CAP_ALIAS[b]] ?? ROSTER_CAPS[b] ?? CAP_DEFAULT[b] ?? 2
  CAPS[b] = Math.max(0, Math.min(16, Number(v) || 0))
}
const CAP_SUM = DISPATCH.reduce((n, b) => n + CAPS[b], 0)

// Verify is ON by default; callers can disable it (here or in the roster) or tune the fix loop.
const VERIFY = (A.verify ?? TC.verify) === false ? false : true
const MAX_FIX = Math.max(0, Math.min(3, Number(A.maxFixLoops ?? TC.max_fix_loops ?? 1) || 0))
// Verifier backend: per-invocation arg > roster team.verifier > 'codex'. Any backend works equally;
// 'native' = Claude judgment (no relay). If the chosen CLI is unavailable at runtime, the relay
// falls back to native judgment loudly (same contract as the dispatch relay path).
const VERIFIER = A.verifier || (A.codexVerify === false ? 'native' : (TC.verifier || 'codex'))

// Human/CLI name for the progress tree: agy is the Gemini CLI; every other backend shows as-is.
function backendLabel(b) { return b === 'agy' ? 'gemini' : String(b || '') }

if (!task || !String(task).trim()) {
  return { error: 'mmt-team: no task provided in args.task' }
}
if (!root) {
  return { error: 'mmt-team: args.pluginRoot is required to locate scripts/run.sh' }
}
if (CAP_SUM === 0) {
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
          backend: { type: 'string', enum: DISPATCH, description: 'which tool runs this subtask — the listed backends are EQUAL options; pick best-fit' },
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

The backends are EQUAL, interchangeable tools — pick the BEST-FIT one for each subtask. None is reserved for "only simple work" or "only verifying". Assign ONLY from the eligible backends this run: ${DISPATCH.join(', ')}.
- "agy" (Gemini CLI): fast & cheap; great for commodity / verifiable work and Gemini's edges — new components, CSS/UI, scaffolding, CRUD, scripts, SQL, regex, configs, unit tests, data transforms, web-research / doc-summary, audio/video. tier "standard" (or "cheap" for tiny/bulk).
- "codex" (Codex CLI): strong on code review, writing/extending tests, verification, and focused, checkable code units. tier "standard" (or "cheap").
- "native" (Claude, in-context): judgment / your-codebase-context / hard-to-verify work, AND the hard line that must NEVER leave native — RE, IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design. Pick the tier BY COMPLEXITY, do NOT default to opus: "sonnet" for ordinary analysis / understanding / reviews / standard logic; "opus" ONLY for the hard line, deep cross-system architecture, or subtle concurrency / perf.

For each subtask also provide:
- "deps": the labels of any OTHER subtasks whose output this one needs. Those run first and their results are handed to this subtask. Use [] when independent. Keep the dependency graph acyclic.
- "verify": one short, checkable acceptance criterion (what makes this subtask's result correct).

Caps — use AT MOST this many subtasks per backend: ${DISPATCH.map((b) => `${CAPS[b]} ${b}`).join(', ')} (skip a backend whose cap is 0). Prefer fewer, well-scoped subtasks; a trivial task is a single subtask. Labels must be unique. Each subtask's "task" must be self-contained.

TASK:
${task}`,
  { label: 'decompose', phase: 'Decompose', schema: PLAN_SCHEMA }
)

// ---- normalize + resolve the routing snapshot (resolved once) ---------------
let raw = ((plan && plan.subtasks) || []).filter((s) => s && s.task && String(s.task).trim())

// Coerce backend + tier: an unknown/ineligible backend -> native (never silently send hard work to
// a CLI). native gets sonnet/opus (by complexity); every other backend gets cheap/standard.
for (const s of raw) {
  s.backend = DISPATCH.includes(s.backend) ? s.backend : 'native'
  if (s.backend === 'native') s.tier = s.tier === 'opus' ? 'opus' : 'sonnet'
  else s.tier = s.tier === 'cheap' ? 'cheap' : 'standard'
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

// Apply per-backend caps (the loud, deterministic part of model dispatching). Each backend is
// capped independently — no backend is privileged.
const kept = []
for (const b of DISPATCH) {
  const ofB = raw.filter((s) => s.backend === b)
  kept.push(...ofB.slice(0, CAPS[b]))
  if (ofB.length > CAPS[b]) log(`dropping ${ofB.length - CAPS[b]} ${b} subtask(s) over cap ${CAPS[b]}`)
}

// Graceful fallback: if nothing survived the caps, run the whole task as one subtask on a backend
// that still has capacity (prefer native for an unscoped ask).
if (kept.length === 0) {
  log('no subtasks survived caps — collapsing to a single subtask')
  const pick = CAPS.native > 0 ? 'native' : (DISPATCH.find((b) => CAPS[b] > 0) || 'native')
  kept.push({ label: 'task', task, backend: pick, tier: pick === 'native' ? 'sonnet' : 'standard', deps: [], verify: '' })
}

// Sanitize deps: keep only edges that point at a surviving label; drop self-edges.
const keptLabels = new Set(kept.map((s) => s.label))
for (const s of kept) {
  const d = Array.isArray(s.deps) ? s.deps : []
  s.deps = [...new Set(d.map(String))].filter((l) => l !== s.label && keptLabels.has(l))
  s.verify = typeof s.verify === 'string' ? s.verify : ''
}

log(`plan: ${DISPATCH.map((b) => `${kept.filter((s) => s.backend === b).length} ${backendLabel(b)}`).join(' + ')} (caps ${DISPATCH.map((b) => `${b}:${CAPS[b]}`).join(' ')}); verify=${VERIFY ? backendLabel(VERIFIER) : 'off'} maxFix=${MAX_FIX}`)

// ---- dispatch primitives ----------------------------------------------------
// Map a plan tier to a concrete model so the plan's COMPLEXITY call actually takes effect — and
// so the map itself is configurable (roster team.tier_models). Without an explicit model, every
// agent here would inherit the main-loop model (e.g. Opus 4.8), which is why native analysis used
// to run on Opus regardless of tier. Default map: cheap->haiku, standard/sonnet->sonnet, opus->opus;
// the roster can remap any tier. This is what makes the model choice "dynamic by complexity".
function tierModel(tier) {
  return TIER_MODELS[tier] || (tier === 'opus' ? 'opus' : 'sonnet')
}

// Any non-native subtask is RELAYED to ITS backend CLI through run.sh (forced decision so routing
// matches the plan). Backends are equal — the same relay drives agy, codex, or any future CLI; the
// backend is a parameter, never hardcoded. The relay returns run.sh's stdout verbatim; only on a
// native-handoff sentinel (CLI unavailable/exhausted) does it solve in-context — our "loud fallback
// when a provider CLI is missing". Label prefixed with the CLI name; the relay is cheap (RELAY_MODEL).
function dispatchRelay(backend, text, tier, label, ph) {
  const be = backendLabel(backend)
  return agent(
`You are a relay — do NOT solve the subtask yourself unless told to. Delegate it to the ${be} backend and return ONLY its output.

Run exactly this with the Bash tool — the subtask rides in on a single-quoted heredoc, so it is inert data and is never parsed by the shell (if the subtask happens to contain the line MMT_SUB_EOF, pick a different unique delimiter):

bash ${JSON.stringify(RUN)} --decision '{"backend":"${backend}","model":"","tier":"${tier}","rule":"team","native":false}' <<'MMT_SUB_EOF'
${text}
MMT_SUB_EOF

Return the command's stdout verbatim. If it begins with "MMT_NATIVE_HANDOFF" (${be} was unavailable), THEN solve the subtask yourself and return that result instead.`,
    { label: `${be}:${label}`, phase: ph || 'Dispatch', model: RELAY_MODEL }
  )
}

function dispatchNative(text, tier, label, ph) {
  return agent(
`Solve this subtask directly and return a complete, self-contained result:\n\n${text}`,
    { label: `native:${label}`, phase: ph || 'Dispatch', model: tierModel(tier) }
  )
}

// Equal backends: native solves in-context; every other backend is relayed to its CLI. No special-casing.
function dispatch(s, text, ph) {
  return s.backend === 'native'
    ? dispatchNative(text, s.tier || 'sonnet', s.label, ph)
    : dispatchRelay(s.backend, text, s.tier || 'standard', s.label, ph)
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
// The Verify stage is delegated to the CONFIGURED verifier backend (roster team.verifier, default
// codex). A native relay agent runs that backend through run.sh to review the result against its
// acceptance criterion, then packages its PASS/FAIL verdict into the structured shape. If the
// backend is unavailable (handoff sentinel) the relay reviews it itself with native judgment — a
// loud fallback, same contract as the commodity dispatch path. `verifier:'native'` skips the relay
// entirely and verifies on native Claude.
async function verifyResult(s, result) {
  if (!VERIFY) return { pass: true, reason: 'verify disabled', fix_hint: '' }
  const handoff = typeof result === 'string' && result.indexOf('MMT_NATIVE_HANDOFF') === 0
  const criterion = s.verify && s.verify.trim()
    ? s.verify.trim()
    : 'The result fully and correctly satisfies the subtask.'

  if (VERIFIER !== 'native') {
    // The configured verifier backend does the review; the relay (native) reports its verdict in
    // the required shape. The review brief rides to run.sh on a single-quoted heredoc, so the
    // (untrusted) subtask + result text is inert data and is never parsed by a shell.
    const vb = backendLabel(VERIFIER)
    const v = await agent(
`You are the verification relay for a multi-model team. Delegate the REVIEW to the ${vb} backend, then report ITS verdict in the required structured form. Do NOT judge the result yourself unless ${vb} is unavailable.

Run exactly this with the Bash tool (if the brief happens to contain the line MMT_VERIFY_EOF, pick a different unique delimiter):

bash ${JSON.stringify(RUN)} --decision '{"backend":"${VERIFIER}","model":"","tier":"standard","rule":"team-verify","native":false}' <<'MMT_VERIFY_EOF'
You are a strict reviewer. Decide whether the RESULT satisfies the ACCEPTANCE CRITERION for the subtask below. Be skeptical: if it is incomplete, wrong, empty, or only describes what should be done instead of doing it, it FAILS. Answer with a first line of exactly PASS or FAIL, then one sentence of reasoning, then (only if FAIL) a concrete one-line fix instruction.

SUBTASK (${s.backend}/${s.tier}, label "${s.label}"):
${s.task}

ACCEPTANCE CRITERION:
${criterion}

RESULT:
${result}
MMT_VERIFY_EOF

Read ${vb}'s stdout and emit the structured verdict reflecting it: pass=true only if it concluded PASS; copy its reasoning into reason and its fix instruction (if any) into fix_hint.${handoff ? ' Note: the subtask result was a native-handoff sentinel — treat it as a failure regardless of what the reviewer says.' : ''} If ${vb}'s stdout begins with "MMT_NATIVE_HANDOFF" (${vb} unavailable/exhausted), THEN review the result yourself with strict native judgment and emit your own verdict instead.`,
      { label: `${vb}:verify:${s.label}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: tierModel(s.tier) }
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
Reconcile overlaps, resolve conflicts, and note which backend ran each part and its verification status. If any subtask is marked "failed", call that out explicitly rather than papering over it.

ORIGINAL TASK:
${task}

SUBTASK RESULTS (JSON):
${JSON.stringify(records, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  task,
  backends: DISPATCH,
  caps: CAPS,
  verify: VERIFY,
  verifier: VERIFY ? VERIFIER : 'off',
  maxFixLoops: MAX_FIX,
  plan: kept.map((s) => ({ label: s.label, backend: s.backend, tier: s.tier, deps: s.deps || [], verify: s.verify || '' })),
  counts: {
    byBackend: Object.fromEntries(DISPATCH.map((b) => [b, kept.filter((s) => s.backend === b).length])),
    verified: records.filter((r) => r.status === 'verified').length,
    failed: failed.length,
  },
  results: records,
  final,
}
