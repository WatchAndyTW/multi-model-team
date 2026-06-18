export const meta = {
  name: 'mmt-team',
  description: 'Model-dispatching team pipeline: decompose a task into subtasks and assign each to the best-fit backend (agy / codex / native — all equal, configurable), dispatch dependency-aware, verify each result on the configured verifier, fix failures in a bounded loop, then synthesize.',
  phases: [
    { title: 'Decompose', detail: 'split into backend-assigned subtasks with deps + verify criteria' },
    { title: 'Setup', detail: 'writable mode only: one git worktree + branch per subtask off HEAD' },
    { title: 'Dispatch', detail: 'dependency-ordered waves: each subtask on its assigned backend (CLI relay or native)' },
    { title: 'Verify', detail: 'score each result against its acceptance criterion' },
    { title: 'Fix', detail: 'bounded re-dispatch of failed subtasks with verifier feedback' },
    { title: 'Integrate', detail: 'writable mode only: merge each worktree into the integration branch, report conflicts' },
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
// Injection-safety: the relay sub-agent WRITES each subtask's payload to a file in .mmt/calls/ (via
// the Write tool — never a shell), then passes only the file PATH to run.mjs (--call-file). The
// (untrusted) subtask text is inert data — it lives in a file, read only in Node, and never appears
// on a command line or as parseable shell text. The path itself is a safe [A-Za-z0-9_/.-] token.
//
// Modes: read-only (DEFAULT) — CLI agents return text, the orchestrator applies edits to the CURRENT
// branch, no branch/worktree/PR. writable (A.writable) — each subtask gets its own git worktree+
// branch off HEAD, the agent writes real changes there (CLI full-auto via run.mjs --cwd --writable),
// and a deterministic Setup/Integrate pair of Bash sub-agents create the worktrees and merge them
// into one integration branch `mmt/team-<slug>` off HEAD (conflicts reported, never auto-resolved;
// the user's branch is untouched; no gh PR). git runs in sub-agents because the Workflow runtime has
// no fs/git; the workflow only orchestrates them deterministically (slug/labels, no Date/random).
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

// ---- writable mode ----------------------------------------------------------
// Two modes:
//   read-only (DEFAULT): CLI agents stay read-only and return text; the ORCHESTRATOR applies any
//     edits directly to the CURRENT branch. No branch, no worktree, no PR (back-compat).
//   writable (A.writable===true / TC.mode==='writable'): each subtask gets its OWN git worktree +
//     branch off current HEAD; the agent (CLI full-auto, or native) writes real changes there; then
//     a deterministic integration stage merges every agent branch into ONE integration branch
//     `mmt/team-<slug>` off current HEAD (conflicts reported), left for the user (no auto-merge onto
//     their branch, no gh PR). The Workflow runtime has no fs/git, so the worktree lifecycle is run
//     by sub-agents (Bash tool); the workflow orchestrates them deterministically.
// Accept boolean true OR the strings "true"/"writable"/"1"/"yes" (args/roster values may arrive as
// strings from a JSON-string arg or a hand-edited roster), so writable mode isn't silently skipped.
function truthyMode(v) {
  if (v === true) return true
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return s === 'true' || s === 'writable' || s === '1' || s === 'yes'
}
const WRITABLE = truthyMode(A.writable) || (A.writable == null && truthyMode(TC.mode))
// Deterministic slug from the task (NO Date/random — the Workflow runtime forbids them and they'd
// break resume). Stable across a resume so the same worktrees/branches are reused.
function slugify(s) {
  return String(s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task'
}
const SLUG = slugify(task)
const INT_BRANCH = `mmt/team-${SLUG}`           // the integration branch (off current HEAD)
const WT_BASE = `.mmt/worktrees/${SLUG}`         // worktrees live under the plugin state dir (gitignored)
const INT_WORKTREE = `${WT_BASE}/__integration__`  // dedicated worktree for INT_BRANCH — merges happen
                                                   // HERE so the user's main checkout is NEVER touched.
// Sanitize a subtask label into a token safe for a git ref AND a filesystem path AND a shell-quoted
// arg. Beyond the char filter we enforce git check-ref-format rules: no consecutive dots (`a..b`), no
// `.lock` suffix, no leading/trailing dot or dash. Deterministic (no Date/random).
function safeLabel(label) {
  let s = String(label || 'task')
    .replace(/[^A-Za-z0-9._-]+/g, '-')   // only ref/path-safe chars
    .replace(/\.{2,}/g, '.')             // collapse `..` (git refs forbid it)
    .replace(/^[-.]+|[-.]+$/g, '')       // no leading/trailing dot or dash
    .slice(0, 48)
    .replace(/[-.]+$/g, '')              // re-trim after the length cap
  if (/\.lock$/i.test(s)) s = s.replace(/\.lock$/i, '-lock')  // git refs can't end in .lock
  return s || 'task'
}
// Verifier backend: per-invocation arg > roster team.verifier > 'codex'. Any backend works equally;
// 'native' = Claude judgment (no relay). If the chosen CLI is unavailable at runtime, the relay
// falls back to native judgment loudly (same contract as the dispatch relay path).
const VERIFIER = A.verifier || (A.codexVerify === false ? 'native' : (TC.verifier || 'codex'))

// Human/CLI name for the progress tree: agy is the Gemini CLI; every other backend shows as-is.
function backendLabel(b) { return b === 'agy' ? 'gemini' : String(b || '') }

// ---- file-based relay transport (the relay-scripting fix) -------------------
// The relay sub-agent may run its one command in EITHER PowerShell or bash. A POSIX heredoc and a
// single-quoted '{...}' JSON arg both break under PowerShell (heredoc = parse error; the quotes get
// stripped/mangled), so the CLI silently never dispatched. Encoding the payload as a base64url arg
// fixed that but was opaque. Instead the relay sub-agent now WRITES the payload to a file under
// .mmt/calls/ (with the Write tool — never a shell) and passes only the file PATH to run.mjs
// (--call-file). The untrusted text lives in a file, is read only in Node, and never touches a
// command line; the path is a safe [A-Za-z0-9_/.-] token that survives verbatim in any shell. No
// command-line length limit applies anymore (the payload isn't on the command line), so the old
// oversize guard is gone. The call JSON holds BOTH the routing decision and the task text.
//
// Determinism: the Workflow runtime forbids Date/random APIs and has no fs — so the call id is
// derived from the (unique) subtask label + a monotonic counter, NOT random, and the file is written
// by the sub-agent, not this script. The relay POSIX path uses forward slashes (cross-shell safe).
let _callSeq = 0
function callFilePath(label) {
  const safe = String(label || 'call').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'call'
  return `.mmt/calls/${safe}-${++_callSeq}.json`
}

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

// Writable-mode setup: the worktree-creation report.
const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true if the integration branch + worktrees were created (or already existed)' },
    base_sha: { type: 'string', description: 'short SHA of current HEAD (the base for all worktrees)' },
    integration_branch: { type: 'string' },
    worktrees: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' }, created: { type: 'boolean' } },
        required: ['label', 'path', 'branch'],
      },
    },
    reason: { type: 'string', description: 'on failure, why (e.g. not a git repo)' },
  },
  required: ['ok'],
}

// Writable-mode integration: the merge-into-integration-branch report.
const INTEGRATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    integration_branch: { type: 'string' },
    base_sha: { type: 'string' },
    merged: { type: 'array', items: { type: 'string' }, description: 'labels successfully merged into the integration branch' },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'labels whose merge hit conflicts (left for the user to resolve)' },
    empty: { type: 'array', items: { type: 'string' }, description: 'labels whose worktree had no changes to merge' },
    summary: { type: 'string', description: 'human-readable summary of the integration outcome + how to inspect/merge the branch' },
    reason: { type: 'string' },
  },
  required: ['ok', 'summary'],
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
function dispatchRelay(backend, text, tier, rule, label, ph, worktree) {
  const be = backendLabel(backend)
  // File-based transport: the relay sub-agent writes the payload (decision + task) to a JSON file
  // under .mmt/calls/ with the Write tool, then runs `node run.mjs --call-file=<path>`. No heredoc,
  // no quoted JSON, no untrusted text on the command line — works verbatim whether the relay runs in
  // PowerShell or bash. run.mjs reads the file in Node. The call id is derived from the label (the
  // Workflow runtime forbids random/Date), so each subtask gets its own file.
  const callPath = callFilePath(label)
  // In writable mode the CLI writes in its worktree: add --cwd=<worktree> --writable so run.mjs runs
  // the backend there with full-auto. In read-only mode neither flag is present (unchanged behaviour).
  const writableFlags = worktree ? ` --cwd=${JSON.stringify(worktree)} --writable` : ''
  const callJson = JSON.stringify({ decision: { backend, model: '', tier, rule, native: false }, task: text }, null, 2)
  const wtNote = worktree
    ? `\n\nWRITABLE MODE: the command includes --cwd (a git worktree) and --writable, so the ${be} CLI will WRITE its changes into that worktree. You are still a pure relay — do NOT edit files yourself, do NOT inspect the worktree, just run the command and report stdout.`
    : ''

  return agent(
`You are a PURE RELAY PIPE for the ${be} backend — NOT a problem solver. Write one file, run ONE command, report its output, stop. Do NOT browse, reason about, or answer the payload yourself; you have no opinion on its content and must never put your own answer in the output.

Step 1 — with the Write tool (NOT a shell command), write EXACTLY this content to the file at the relative path "${callPath}" (create the .mmt/calls/ directory if the Write tool requires it — it normally creates parents):

${callJson}

Step 2 — run EXACTLY this with the Bash tool and nothing else. The payload is in the file you just wrote; only its PATH is on the command line (inert, safe in any shell). Do NOT inline or echo the payload:

node ${JSON.stringify(RUN)} --call-file=${JSON.stringify(callPath)}${writableFlags}

CRITICAL — run it in the FOREGROUND and WAIT for it to finish. The ${be} CLI can legitimately take several minutes on a hard task; run.mjs blocks until it completes (it has its own generous timeout). Do NOT background it (no \`&\`, no \`run_in_background\`), do NOT wrap it in your own \`sleep\`/\`timeout\`/\`tail -f\`, and do NOT give up early — a slow response is NOT a failure. If your Bash tool reports its own time limit, simply run the SAME command again and keep waiting; run.mjs prints a "[mmt] backend still running (Ns)…" heartbeat to stderr and writes a status file next to the call file ("<the call-file path>.status.json", {state:"running"|"done"|"failed"}) you can read to confirm it is still alive.${wtNote}

Report: stdout = the command's EXACT stdout, copied verbatim. backend_ran = false if that stdout is empty or begins with "MMT_NATIVE_HANDOFF" (the ${be} CLI was unavailable/exhausted), true otherwise. Do NOT solve the payload even if backend_ran is false — just report it.`,
    { label: `${be}:${label}`, phase: ph || 'Dispatch', model: RELAY_MODEL, schema: RELAY_SCHEMA }
  )
}

// Native solver. In writable mode it WRITES its changes into the subtask's worktree (cwd) directly;
// in read-only mode it just returns a self-contained result (the orchestrator applies any edits).
function dispatchNative(text, tier, label, ph, worktree) {
  const body = worktree
    ? `Implement this subtask by WRITING the actual file changes into the git worktree at "${worktree}". cd into it first, edit/create the real files there (use the Edit/Write tools or shell), and leave the working tree with your changes (do NOT commit — the integration stage commits). Then return a short summary of what you changed (files + rationale).\n\nSUBTASK:\n${text}`
    : `Solve this subtask directly and return a complete, self-contained result:\n\n${text}`
  return agent(body, { label: `native:${label}`, phase: ph || 'Dispatch', model: tierModel(tier) })
}

// Equal backends: native solves in-context; every other backend is relayed to its CLI through the
// faithful pipe. Returns { result, ranOn } so the record can report WHICH backend actually produced
// the result. If the CLI didn't run (unavailable/exhausted), we fall back to native LOUDLY and
// VISIBLY — a real `native:<label>-fallback` agent, not a Claude answer hidden behind the CLI's label.
// Per-subtask worktree path (writable mode only). Each subtask gets its own isolated checkout so
// parallel writes don't collide; the integration stage merges them. '' in read-only mode.
function worktreeFor(label) { return WRITABLE ? `${WT_BASE}/${safeLabel(label)}` : '' }
// Per-subtask integration branch name (sanitized label). Used by Setup + Integrate so the names match.
function branchFor(label) { return `${INT_BRANCH}/${safeLabel(label)}` }

async function dispatch(s, text, ph) {
  const wt = worktreeFor(s.label)
  if (s.backend === 'native') {
    return { result: await dispatchNative(text, s.tier || 'sonnet', s.label, ph, wt), ranOn: 'native' }
  }
  const relay = await dispatchRelay(s.backend, text, s.tier || 'standard', 'team', s.label, ph, wt)
  if (relay && relay.backend_ran === true && typeof relay.stdout === 'string' && relay.stdout.trim()) {
    return { result: relay.stdout, ranOn: s.backend }
  }
  log(`${backendLabel(s.backend)} unavailable for "${s.label}" — visible native fallback`)
  // Fallback native solver still writes into the SAME worktree (the work must land regardless of which
  // backend produced it), so the integration stage sees one branch per subtask either way.
  const result = await dispatchNative(text, s.tier === 'opus' ? 'opus' : 'sonnet', `${s.label}-fallback`, ph, wt)
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
    // review brief rides to run.mjs via a .mmt/calls/ file (--call-file) — the (untrusted) subtask +
    // result text is inert data in a file, read only in Node, never parsed by a shell. rule
    // "team-verify" forces the verifier.
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

// ---- 1.5 · Writable setup: one git worktree + branch per subtask ------------
// The Workflow runtime can't run git itself, so a single setup sub-agent (Bash) creates the
// integration branch off current HEAD and a worktree+branch per subtask. Deterministic: branch/
// worktree names are derived from the slug+labels (no Date/random), so a resume reuses them. In
// read-only mode this stage is skipped entirely (no branch — per the user's contract).
let setupReport = null
if (WRITABLE) {
  phase('Setup')
  const wtLines = kept.map((s) => `  - label "${s.label}": worktree "${worktreeFor(s.label)}" on branch "${branchFor(s.label)}"`).join('\n')
  setupReport = await agent(
`You are the WRITABLE-MODE SETUP agent for the multi-model-team /team pipeline. Use the Bash tool to prepare isolated git worktrees. Do NOT solve any task — only run git plumbing and report. Every branch/worktree op is IDEMPOTENT (this may be a resume — skip anything that already exists; never error out just because it exists).

This repo's current HEAD is the base. The user's current branch must stay checked out and UNTOUCHED — do NOT \`git switch\`/\`git checkout\` in the main working tree. Do EXACTLY this:
1. Confirm you are in a git repo: \`git rev-parse --is-inside-work-tree\`. If not, report {ok:false, reason:"not a git repo"} and stop.
2. Create the integration branch off CURRENT HEAD, idempotently (do NOT switch to it):
   \`git show-ref --verify --quiet refs/heads/${INT_BRANCH} || git branch ${JSON.stringify(INT_BRANCH)} HEAD\`
3. Create a DEDICATED integration WORKTREE so later merges never touch the user's checkout (idempotent — skip if the path already exists):
   \`git worktree add ${JSON.stringify(INT_WORKTREE)} ${JSON.stringify(INT_BRANCH)}\`  (omit -b: the branch already exists from step 2)
4. For EACH subtask below, create a worktree on its own branch off HEAD (idempotent — for each, if the worktree path exists skip it, else \`git worktree add -b "<branch>" "<worktree>" HEAD\`; if the branch already exists drop -b and check it out into the new worktree). Worktrees live under .mmt/ (gitignored):
${wtLines}
5. Report which worktrees now exist (include the integration worktree).

Return JSON: { ok: boolean, base_sha: "<git rev-parse --short HEAD>", integration_branch: ${JSON.stringify(INT_BRANCH)}, worktrees: [{label, path, branch, created}], reason?: string }. Use label "__integration__" for the integration worktree entry.`,
    { label: 'setup-worktrees', phase: 'Setup', model: tierModel('sonnet'), schema: SETUP_SCHEMA }
  )
  if (!setupReport || setupReport.ok !== true) {
    log(`writable setup failed (${(setupReport && setupReport.reason) || 'unknown'}) — aborting writable run`)
    return { task, mode: 'writable', error: `writable setup failed: ${(setupReport && setupReport.reason) || 'unknown'}`, setup: setupReport }
  }
  log(`writable: integration branch ${INT_BRANCH} off ${setupReport.base_sha}; ${(setupReport.worktrees || []).length} worktree(s) ready`)
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

// ---- usage accounting -------------------------------------------------------
// The Workflow runtime can't read per-agent token counts (those arrive in the task-notification's
// aggregate `subagent_tokens`), but it knows WHO ran each piece of work. Classify every record by
// executor so the operator can see how the budget split: CLI-executed subtasks ran on agy/codex (OFF
// Claude's token budget — only the thin relay agent spent native tokens), while native-executed
// subtasks (incl. native-fallbacks) ran on Claude (ON the token budget). Result char counts are a
// concrete size proxy (the workflow has the text; it does NOT have token numbers). The orchestrator
// folds the notification's `subagent_tokens` total into this split when reporting to the user.
function approxChars(r) { return typeof r.result === 'string' ? [...r.result].length : 0 }
const cliRecords = records.filter((r) => r.ranOn === 'agy' || r.ranOn === 'codex')
const nativeRecords = records.filter((r) => r.ranOn === 'native' || (typeof r.ranOn === 'string' && r.ranOn.indexOf('native-fallback') === 0))
const usage = {
  note: 'Per-agent token counts are not visible inside the workflow; see the run notification\'s aggregate subagent_tokens. This is the executor split + output-size proxy.',
  cli: {
    subtasks: cliRecords.length,
    byBackend: Object.fromEntries(['agy', 'codex'].map((b) => [b, records.filter((r) => r.ranOn === b).length]).filter(([, n]) => n > 0)),
    output_chars: cliRecords.reduce((n, r) => n + approxChars(r), 0),
    comment: 'ran on the CLI backend — off Claude\'s token budget (only the relay agent spent native tokens)',
  },
  native: {
    subtasks: nativeRecords.length,
    fallbacks: fellBack.length,
    output_chars: nativeRecords.reduce((n, r) => n + approxChars(r), 0),
    comment: 'ran on native Claude — on the token budget (includes CLI->native fallbacks)',
  },
  relay_agents: cliRecords.length,           // one thin relay agent per CLI subtask (RELAY_MODEL)
  orchestration_agents: 2 + (VERIFY ? records.length : 0), // decompose + synthesize (+ one verify/subtask)
}
if (cliRecords.length) log(`usage: ${cliRecords.length} subtask(s) executed on CLI (off-budget); ${nativeRecords.length} on native Claude`)

// ---- 2.5 · Writable integration: merge worktrees -> integration branch ------
// A single integration sub-agent (Bash) commits each subtask's worktree on its branch, merges every
// branch into the integration branch (off HEAD), reports conflicts (left for the user — NOT
// auto-resolved blindly), and removes the worktrees. The user's current branch is NEVER touched; the
// result sits on `${INT_BRANCH}` for them to inspect / merge / PR. No gh PR is created.
let integration = null
if (WRITABLE) {
  phase('Integrate')
  const labelLines = kept.map((s) => `  - "${s.label}": worktree "${worktreeFor(s.label)}", branch "${branchFor(s.label)}"`).join('\n')
  integration = await agent(
`You are the WRITABLE-MODE INTEGRATION agent for the multi-model-team /team pipeline. Use the Bash tool to merge each subtask's worktree into the integration branch. Do NOT solve any task or write feature code — only git plumbing + an honest report.

CRITICAL SAFETY RULE: all merges happen INSIDE the dedicated integration worktree at "${INT_WORKTREE}" (checked out to "${INT_BRANCH}"). NEVER run \`git switch\`/\`git checkout\` in the main working tree, and NEVER merge the integration branch into the user's current branch. The user's checkout must end exactly as it started.

Integration branch: "${INT_BRANCH}" (already created off the original HEAD). Integration worktree: "${INT_WORKTREE}".
Subtasks (each wrote changes into its own worktree):
${labelLines}

Do EXACTLY this, in order:
1. For EACH subtask worktree: \`git -C "<worktree>" add -A\`; if there are staged changes, commit them: \`git -C "<worktree>" commit -m "mmt(${SLUG}): <label>"\`. If the worktree has NO changes (\`git -C "<worktree>" status --porcelain\` empty), record the label under "empty" and skip it.
2. From the INTEGRATION WORKTREE only, merge each non-empty subtask branch into "${INT_BRANCH}", one at a time, no-fast-forward (visible merge commit):
   \`git -C ${JSON.stringify(INT_WORKTREE)} merge --no-ff -m "mmt(${SLUG}): merge <label>" "<branch>"\`
   If a merge hits CONFLICTS, do NOT guess — \`git -C ${JSON.stringify(INT_WORKTREE)} merge --abort\`, record the label under "conflicts", and KEEP that subtask's worktree (do not remove it) so the user has the change to resolve. Continue with the rest.
3. Remove ONLY the cleanly-merged and empty subtask worktrees (\`git worktree remove --force "<path>"\`). Keep conflicted worktrees AND the integration worktree "${INT_WORKTREE}" in place. Do NOT delete the integration branch and do NOT touch the user's branch.
4. Report honestly: which labels merged, which conflicted (still need manual resolution), which were empty.

Return JSON matching the schema: { ok, integration_branch, base_sha, merged:[label], conflicts:[label], empty:[label], summary, reason? }. The summary MUST tell the user how to inspect the result (e.g. "git log ${INT_BRANCH}" or open the integration worktree at "${INT_WORKTREE}") and that conflicts (if any) remain for them to resolve in those kept worktrees.`,
    { label: 'integrate-worktrees', phase: 'Integrate', model: tierModel('sonnet'), schema: INTEGRATE_SCHEMA }
  )
  if (integration && Array.isArray(integration.conflicts) && integration.conflicts.length) {
    log(`writable: ${integration.conflicts.length} subtask(s) had merge conflicts on ${INT_BRANCH} (left for you): ${integration.conflicts.join(', ')}`)
  }
  log(`writable: integration ${integration && integration.ok ? 'complete' : 'had problems'} on ${INT_BRANCH} — ${integration ? integration.summary : 'no report'}`)
}

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
  mode: WRITABLE ? 'writable' : 'read-only',
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
  usage,
  // Writable mode only: the integration branch + per-subtask merge outcome (null in read-only mode).
  // The user's current branch is untouched; changes sit on `integration.integration_branch`.
  writable: WRITABLE ? { integration_branch: INT_BRANCH, setup: setupReport, integration } : null,
  results: records,
  final,
}
