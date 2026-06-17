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
// Injection-safety: agy subtasks ride to run.mjs as base64url args (--task-b64/--decision-b64),
// so the (untrusted) subtask text is inert data, decoded only in Node and never parsed by a shell.
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
const RELAY_MODEL = A.relayModel || TC.relay_model || 'haiku'          // model the thin relay agents run on
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

// ---- shell-agnostic base64url encoder (the relay-scripting fix) -------------
// The relay sub-agent may run its one command in EITHER PowerShell or bash. A POSIX heredoc and a
// single-quoted '{...}' JSON arg both break under PowerShell (heredoc = parse error; the quotes get
// stripped/mangled), so the CLI silently never dispatched. We instead carry the payload + decision
// as base64url args ([A-Za-z0-9_-] only) — inert in EVERY shell, no quoting of untrusted text, and
// '/'-free so MSYS/Git Bash argv path-conversion can't corrupt them. run.mjs decodes with Buffer.
// Buffer is NOT guaranteed in the Workflow sandbox, so this encoder is pure JS (standard built-ins
// only; no Buffer, no Date/random) — deterministic, resume-safe.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function utf8Bytes(s) {
  s = String(s ?? '')
  const out = []
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++ }
      else cp = 0xfffd
    } else if (cp >= 0xdc00 && cp <= 0xdfff) { cp = 0xfffd }
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return out
}
function b64url(s) {
  const bytes = utf8Bytes(s)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1]; const c = bytes[i + 2]
    out += B64_ALPHABET[a >> 2]
    out += B64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[c & 63] : '='
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
// Windows CreateProcess caps a command line near 32767 chars; base64 inflates ~33%. Guard the
// encoded command length and fall back to a VISIBLE native agent for an oversized payload rather
// than spawn a relay whose command line would be truncated (which would silently misdispatch).
const MAX_RELAY_ARG_CHARS = 28000

if (!task || !String(task).trim()) {
  return { error: 'mmt-team: no task provided in args.task' }
}
if (!root) {
  return { error: 'mmt-team: args.pluginRoot is required to locate src/bin/run.mjs' }
}
if (CAP_SUM === 0) {
  return { error: 'mmt-team: caps sum to 0 — no agents available to dispatch' }
}

const RUN = `${root}/src/bin/run.mjs`

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

// A non-native backend can only be reached by shelling out to run.sh, and the Workflow runtime can't
// shell out itself — so we MUST spawn a sub-agent (it has the Bash tool) to run the command. That
// sub-agent is a PURE PIPE: it runs ONE command and reports the verbatim stdout plus whether the CLI
// actually produced output. It is FORBIDDEN from solving/analyzing the payload itself. This schema is
// what makes the relay faithful: it forces a structured report (the agent can't ramble its own answer
// in place of the CLI's output), and `backend_ran` lets deterministic code decide the fallback —
// so a CLI-unavailable subtask is re-dispatched as a VISIBLE native: agent, never a Claude analysis
// wearing a `gemini:`/`codex:` label.
const RELAY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stdout: { type: 'string', description: "the command's EXACT stdout, copied verbatim — never summarized, rewritten, or answered by you" },
    backend_ran: { type: 'boolean', description: 'false if that stdout is empty or begins with MMT_NATIVE_HANDOFF (the CLI was unavailable/exhausted); true otherwise' },
  },
  required: ['stdout', 'backend_ran'],
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

// dispatchRelay — the FAITHFUL pure-pipe primitive. A non-native backend is reached ONLY by shelling
// out to run.sh (forced decision, so routing matches the plan). The relay sub-agent runs that one
// command and reports {stdout, backend_ran} — it does NOT solve, analyze, or "helpfully" answer the
// payload. This is the fix for the dress-up bug: previously the relay was told to "solve the subtask
// yourself" on a native-handoff, so a `gemini:`/`codex:`-labelled agent would quietly produce Claude
// output whenever the CLI was unavailable. Now the relay never substitutes its own work; whether to
// fall back (and that the fallback is a VISIBLE native: agent) is decided in deterministic code by the
// caller. Backends are equal — the same pipe drives agy, codex, or any future CLI (backend + rule are
// parameters, never hardcoded). Label is prefixed with the CLI name; the pipe is cheap (RELAY_MODEL).
function dispatchRelay(backend, text, tier, rule, label, ph) {
  const be = backendLabel(backend)
  // Build the ONE relay command as shell-agnostic base64url args (no heredoc, no quoted JSON, no
  // untrusted text on the command line). Works verbatim whether the relay sub-agent runs it in
  // PowerShell or bash. run.mjs decodes --task-b64 / --decision-b64 in Node.
  const decisionB64 = b64url(JSON.stringify({ backend, model: '', tier, rule, native: false }))
  const taskB64 = b64url(text)
  const command = `node ${JSON.stringify(RUN)} --decision-b64=${decisionB64} --task-b64=${taskB64}`

  // Oversize guard: a payload too big to fit the command line can't be relayed without truncation.
  // Signal the caller to do a VISIBLE native fallback (same contract as a CLI-unavailable result),
  // never spawn a relay that would silently misdispatch.
  if (command.length > MAX_RELAY_ARG_CHARS) {
    log(`relay payload for "${label}" too large to dispatch on ${be} (${command.length} > ${MAX_RELAY_ARG_CHARS} chars) — visible native fallback`)
    return Promise.resolve({ stdout: '', backend_ran: false })
  }

  return agent(
`You are a PURE RELAY PIPE for the ${be} backend — NOT a problem solver. Run ONE command, report its output, stop. Do NOT read files, browse, reason about, or answer the payload yourself; you have no opinion on its content and must never put your own answer in the output.

Run EXACTLY this with the Bash tool and nothing else. It is a single self-contained line — the payload and the routing decision are carried as base64url arguments (inert data, safe in any shell, never parsed). Do NOT modify, decode, or "fix" the arguments:

${command}

Report: stdout = the command's EXACT stdout, copied verbatim. backend_ran = false if that stdout is empty or begins with "MMT_NATIVE_HANDOFF" (the ${be} CLI was unavailable/exhausted), true otherwise. Do NOT solve the payload even if backend_ran is false — just report it.`,
    { label: `${be}:${label}`, phase: ph || 'Dispatch', model: RELAY_MODEL, schema: RELAY_SCHEMA }
  )
}

function dispatchNative(text, tier, label, ph) {
  return agent(
`Solve this subtask directly and return a complete, self-contained result:\n\n${text}`,
    { label: `native:${label}`, phase: ph || 'Dispatch', model: tierModel(tier) }
  )
}

// Equal backends: native solves in-context; every other backend is relayed to its CLI through the
// faithful pipe. Returns { result, ranOn } so the record can report WHICH backend actually produced
// the result. If the CLI didn't run (unavailable/exhausted), we fall back to native LOUDLY and
// VISIBLY — a real `native:<label>-fallback` agent, not a Claude answer hidden behind the CLI's label.
async function dispatch(s, text, ph) {
  if (s.backend === 'native') {
    return { result: await dispatchNative(text, s.tier || 'sonnet', s.label, ph), ranOn: 'native' }
  }
  const relay = await dispatchRelay(s.backend, text, s.tier || 'standard', 'team', s.label, ph)
  if (relay && relay.backend_ran === true && typeof relay.stdout === 'string' && relay.stdout.trim()) {
    return { result: relay.stdout, ranOn: s.backend }
  }
  log(`${backendLabel(s.backend)} unavailable for "${s.label}" — visible native fallback`)
  const result = await dispatchNative(text, s.tier === 'opus' ? 'opus' : 'sonnet', `${s.label}-fallback`, ph)
  return { result, ranOn: `native-fallback(${s.backend})` }
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
// The Verify stage runs on the CONFIGURED verifier backend (roster team.verifier, default codex).
// For a CLI verifier we drive it through the SAME faithful pipe (dispatchRelay) and parse its
// PASS/FAIL verdict in DETERMINISTIC code — no Claude agent re-judges the CLI's output, so the CLI
// can't be silently impersonated. If that CLI is unavailable (backend_ran=false) we fall back to a
// VISIBLE native verifier; `verifier:'native'` uses native judgment directly with no relay.

// Deterministic PASS/FAIL parse of a strict reviewer's stdout: line 1 is PASS/FAIL, the rest is the
// reason, and (on FAIL) a trailing one-line fix. Keeps the verdict honest to what the CLI said.
function parseVerdict(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const pass = /^pass\b/i.test(lines[0] || '')
  const reason = (lines.slice(1).join(' ') || (pass ? 'reviewer passed it' : 'reviewer failed it')).slice(0, 400)
  const fix_hint = pass ? '' : (lines.slice(2).join(' ') || lines.slice(1).join(' ') || '')
  return { pass, reason, fix_hint }
}

// Native verifier: strict Claude judgment. Used when verifier:'native', and as the VISIBLE fallback
// when a CLI verifier is unavailable (labelled native:verify: so it is never mistaken for the CLI).
function nativeVerify(s, result, criterion, handoff, note) {
  return agent(
`You are a strict verifier (native Claude judgment).${note ? ' ' + note : ''} Decide whether the RESULT satisfies the acceptance criterion for this subtask. Be skeptical: if it is incomplete, wrong, empty, or only describes what should be done instead of doing it, fail it.${handoff ? ' (The subtask backend reported it was unavailable — treat a bare handoff sentinel as a failure.)' : ''}

SUBTASK (${s.backend}/${s.tier}, label "${s.label}"):
${s.task}

ACCEPTANCE CRITERION:
${criterion}

RESULT:
${result}`,
    { label: `native:verify:${s.label}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: tierModel(s.tier) }
  )
}

async function verifyResult(s, result) {
  if (!VERIFY) return { pass: true, reason: 'verify disabled', fix_hint: '' }
  const handoff = typeof result === 'string' && result.indexOf('MMT_NATIVE_HANDOFF') === 0
  const criterion = s.verify && s.verify.trim()
    ? s.verify.trim()
    : 'The result fully and correctly satisfies the subtask.'

  if (VERIFIER !== 'native') {
    // Drive the verifier CLI through the faithful pipe, then parse ITS verdict deterministically. The
    // review brief rides to run.mjs as a base64url arg — the (untrusted) subtask + result text is
    // inert data, decoded only in Node, never parsed by a shell. rule "team-verify" forces the verifier.
    const vb = backendLabel(VERIFIER)
    const brief =
`You are a strict reviewer. Decide whether the RESULT satisfies the ACCEPTANCE CRITERION for the subtask below. Be skeptical: if it is incomplete, wrong, empty, or only describes what should be done instead of doing it, it FAILS. Answer with a first line of exactly PASS or FAIL, then one sentence of reasoning, then (only if FAIL) a concrete one-line fix instruction.

SUBTASK (${s.backend}/${s.tier}, label "${s.label}"):
${s.task}

ACCEPTANCE CRITERION:
${criterion}

RESULT:
${result}`
    const relay = await dispatchRelay(VERIFIER, brief, 'standard', 'team-verify', `verify:${s.label}`, 'Verify')
    if (relay && relay.backend_ran === true && typeof relay.stdout === 'string' && relay.stdout.trim()) {
      // A native-handoff in the SUBTASK result is always a failure, regardless of the review verdict.
      if (handoff) return { pass: false, reason: `subtask backend (${s.backend}) was unavailable — native-handoff sentinel`, fix_hint: 'solve the subtask natively' }
      return parseVerdict(relay.stdout)
    }
    // Verifier CLI unavailable -> VISIBLE native verify (not hidden behind the CLI's label).
    log(`verifier ${vb} unavailable for "${s.label}" — visible native verify fallback`)
    const vf = await nativeVerify(s, result, criterion, handoff, `(${vb} was unavailable, verifying natively.)`)
    return vf || { pass: true, reason: 'verifier returned nothing; accepting', fix_hint: '' }
  }

  // Native verifier (knob: verifier:'native' / codexVerify:false).
  const v = await nativeVerify(s, result, criterion, handoff)
  return v || { pass: true, reason: 'verifier returned nothing; accepting', fix_hint: '' }
}

// ---- one subtask, end to end: dispatch -> verify -> bounded fix loop ---------
async function runSubtask(s, ctx) {
  const text = withContext(s, ctx)
  let { result, ranOn } = await dispatch(s, text)
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
    const d = await dispatch({ ...s, label: `${s.label}#fix${attempts}` }, fixText, 'Fix')
    result = d.result
    ranOn = d.ranOn        // the last attempt's actual executor is what we report
    verdict = await verifyResult(s, result)
    attempts++
  }
  const status = !VERIFY ? 'unverified' : verdict && verdict.pass ? 'verified' : 'failed'
  // `ranOn` = the backend that ACTUALLY produced the result (= backend, or native-fallback(<cli>) if
  // the CLI was unavailable). This is the honest record of who did the work, distinct from the plan.
  return { label: s.label, backend: s.backend, ranOn, tier: s.tier, deps: s.deps || [], attempts, status, verdict, result }
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
// Loudly surface any CLI->native fallback (the user's exact complaint: work that was supposed to run
// on a CLI backend actually ran on Claude). `ranOn` records the truth per subtask.
const fellBack = records.filter((r) => typeof r.ranOn === 'string' && r.ranOn.indexOf('native-fallback') === 0)
if (fellBack.length) log(`${fellBack.length} subtask(s) fell back to native (CLI unavailable): ${fellBack.map((r) => `${r.label} [${r.ranOn}]`).join(', ')}`)

// ---- 3 · Synthesize ---------------------------------------------------------
phase('Synthesize')
const final = await agent(
`Synthesize these verified subtask results into one coherent, complete answer to the original task.
Reconcile overlaps, resolve conflicts, and note which backend ACTUALLY ran each part (the "ranOn" field — e.g. "native-fallback(agy)" means the agy CLI was unavailable and Claude did it) and its verification status. If any subtask is marked "failed", call that out explicitly rather than papering over it.

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
    ranOn: Object.fromEntries([...new Set(records.map((r) => r.ranOn))].map((k) => [k, records.filter((r) => r.ranOn === k).length])),
    verified: records.filter((r) => r.status === 'verified').length,
    failed: failed.length,
    nativeFallbacks: fellBack.length,
  },
  results: records,
  final,
}
