export const meta = {
  name: 'mmt-team',
  description: 'Model-dispatching team pipeline: decompose a task into subtasks and assign each to the best-fit backend (agy / codex / native — all equal, configurable), dispatch dependency-aware, verify each result on the configured verifier, fix failures in a bounded loop, then synthesize.',
  phases: [
    { title: 'Decompose', detail: 'split into backend-assigned subtasks with deps + verify criteria' },
    { title: 'Setup', detail: 'writable mode only: one git worktree + branch per subtask off HEAD' },
    { title: 'Dispatch', detail: 'dependency-ordered waves: each subtask on its assigned backend (CLI relay or native)' },
    { title: 'Verify', detail: 'score each result against its acceptance criterion' },
    { title: 'Fix', detail: 'bounded re-dispatch of failed subtasks with verifier feedback' },
    { title: 'Integrate', detail: 'writable mode only: cherry-pick each worktree commit onto the integration branch (no merge commits), orchestrator resolves any conflicts' },
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
// and a deterministic Setup/Integrate pair of Bash sub-agents create the worktrees and cherry-pick
// each subtask commit onto one integration branch `mmt/team-<slug>` off HEAD (NO merge commits — one
// clean raw commit per subtask); the orchestrator RESOLVES any conflicts itself and folds the fix
// into that same raw commit, so the user gets one finished, conflict-free branch with a clean linear
// history (the user's branch is untouched; no gh PR). git runs in sub-agents because the runtime has no
// fs/git; the workflow only orchestrates them deterministically (slug/labels, no Date/random).
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
//     a deterministic integration stage cherry-picks every agent's commit onto ONE integration branch
//     `mmt/team-<slug>` off current HEAD (no merge commits — one clean raw commit per subtask), the
//     orchestrator RESOLVING any conflicts so the branch is finished + conflict-free (no auto-merge
//     onto their branch, no gh PR). The Workflow runtime has
//     no fs/git, so the worktree lifecycle is run by sub-agents (Bash tool); the workflow
//     orchestrates them deterministically.
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

// Relay Bash-timeout pinning (the "fails-without-a-reason" fix). The relay sub-agent shells out to
// run.mjs, which has its OWN generous hard_timeout (SIGKILL on expiry; roster default 15m). The relay
// must set its Bash tool's timeout LONGER than that, or the relay's own tool fires first on a slow CLI
// call and the relay (a cheap model) mishandles the recovery — silently dropping a slow-but-successful
// dispatch to native and reporting a generic "unavailable". We surface an explicit target so the relay
// prompt can instruct it. Derive from teamConfig.hard_timeout if present ("15m"/ms), else 15m; the
// relay budget is hard_timeout + 60s of headroom, clamped to a sane band. (Whether the harness honors a
// per-call Bash timeout this large is best-effort — the status-file-authoritative fallback below is the
// real safety net; this just removes the trigger when it IS honored.)
function parseDurationMs(raw, dflt) {
  if (raw == null || raw === '') return dflt
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 0 ? raw : dflt
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i)
  if (!m) return dflt
  const n = parseFloat(m[1]); if (!Number.isFinite(n) || n <= 0) return dflt
  const mult = { '': 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return Math.round(n * mult[(m[2] || '').toLowerCase()])
}
const HARD_TIMEOUT_MS = parseDurationMs(TC.hard_timeout, 15 * 60 * 1000)
// The Claude Code Bash tool caps its per-call timeout at 600000ms (10 min) — asking for more is
// silently unfollowable. So pin the relay's Bash timeout to that ceiling (the max the tool honors).
// run.mjs's hard_timeout can exceed 10 min, so for the longest CLI runs the relay's tool WILL still
// fire — that is exactly why the status-file-authoritative recovery (relaySucceeded) is the real
// safety net: it reclaims a state:"done" result the relay lost to its own tool timeout. The pin just
// removes the trigger for the common (sub-10-min) case.
const BASH_TOOL_MAX_MS = 600000
const RELAY_BASH_TIMEOUT_MS = Math.max(120000, Math.min(BASH_TOOL_MAX_MS, HARD_TIMEOUT_MS))

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
    // The AUTHORITATIVE truth about the dispatch lives in run.mjs's status file, NOT in your
    // backend_ran judgment. Read "<call-file>.status.json" after the command returns (or after a
    // recovery wait) and copy these fields verbatim. Deterministic code TRUSTS the status file over
    // backend_ran — so a slow-but-successful CLI run is never misclassified as "unavailable" just
    // because you (the relay) timed out or hesitated. Leave them empty/0 ONLY if the status file truly
    // never appeared.
    status_state: { type: 'string', description: 'the "state" field from <call-file>.status.json: "done" | "failed" | "running" | "" (empty if no status file existed).' },
    out_chars: { type: 'number', description: 'the "out_chars" field from the status file on a done run (0 if absent).' },
    fail_kind: { type: 'string', description: 'on a failed run, the status file\'s "kind" (e.g. "timeout" | "quota" | "health" | "nonzero-exit" | "empty-output"); else "".' },
    relay_note: { type: 'string', description: 'one short phrase on what happened from YOUR side if the command did not cleanly return — e.g. "my bash tool timed out, status showed done", "re-ran once". Empty on a normal clean return.' },
    // RECOVERY: if your Bash tool timed out and you lost the live stdout, but the status file says
    // state:"done" and carries an "out_file" path, READ that file and put its FULL contents here. This is
    // how a 10-30min CLI job (longer than your 10min tool window) still returns its real result — run.mjs
    // persisted the output to out_file before finishing. Leave empty if you already have stdout.
    recovered_stdout: { type: 'string', description: 'the FULL contents of the status file\'s "out_file" sidecar, read back ONLY when you lost the live stdout but state:"done". Empty otherwise.' },
  },
  required: ['stdout', 'backend_ran'],
}

// Writable-mode worktree reset (before a native fallback): a dedicated Bash plumbing agent runs the
// reset+clean deterministically and reports ok — the cleanup is NOT left to the free-form native
// solver's prose (an LLM solver could skip/mistype it and then build on a half-written worktree). Same
// principle as not trusting the relay's backend_ran: a deterministic git op is run by a thin, single-
// purpose agent and its result is checked in code.
const RESET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true ONLY if BOTH `git reset --hard <base>` AND `git clean -fd` exited 0' },
    head_after: { type: 'string', description: 'short SHA of the worktree HEAD after the reset (git rev-parse --short HEAD)' },
    reason: { type: 'string', description: 'on failure, the git error; else empty' },
  },
  required: ['ok'],
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

// Writable-mode integration: the cherry-pick-onto-integration-branch report.
const INTEGRATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    integration_branch: { type: 'string' },
    base_sha: { type: 'string' },
    merged: { type: 'array', items: { type: 'string' }, description: 'labels that cherry-picked CLEANLY onto the integration branch (one raw commit each)' },
    resolved: { type: 'array', items: { type: 'string' }, description: 'labels that hit conflicts which the orchestrator RESOLVED, folded into the same raw commit (cherry-pick --continue)' },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'labels whose conflict could not be safely resolved and were left for the user (rare)' },
    empty: { type: 'array', items: { type: 'string' }, description: 'labels whose worktree had no changes to integrate' },
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
  // Empty-payload guard: never spawn a relay with a missing/blank task. An empty `text` would be
  // dropped by JSON.stringify (the call file would have no "task" field) and the CLI would run on
  // nothing. Short-circuit to a visible native fallback (backend_ran:false) instead — the same
  // contract as a CLI-unavailable result, decided in deterministic code.
  if (text == null || !String(text).trim()) {
    log(`relay for "${label}" had an empty task — skipping ${be}, visible native fallback`)
    return Promise.resolve({ stdout: '', backend_ran: false })
  }
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

SELF-CHECK before writing: the "task" value above must be the REAL task text, never a literal placeholder like "<the subtask text>" or "<the question text>". If you see an unsubstituted \`<...>\` placeholder in it, STOP — do NOT write the file or run the command; report backend_ran:false with empty stdout instead.

Step 2 — run EXACTLY this with the Bash tool and nothing else, and set the Bash tool's own timeout parameter to ${RELAY_BASH_TIMEOUT_MS} ms (the max your tool allows) so it does NOT fire early on a slow ${be} call (run.mjs has its own ${Math.round(HARD_TIMEOUT_MS / 60000)}-minute SIGKILL; if your tool still times out before run.mjs finishes, that is NOT a failure — recover via the status file as described below). The payload is in the file you just wrote; only its PATH is on the command line (inert, safe in any shell). Do NOT inline or echo the payload:

node ${JSON.stringify(RUN)} --call-file=${JSON.stringify(callPath)}${writableFlags}

CRITICAL — run it in the FOREGROUND and WAIT for it to finish. The ${be} CLI can legitimately take MANY MINUTES on a hard task; run.mjs blocks until it completes (it has its own generous timeout and will SIGKILL the CLI on expiry). Do NOT background it (no \`&\`, no \`run_in_background\`), do NOT wrap it in your own \`sleep\`/\`timeout\`/\`tail -f\`, and do NOT give up early — a slow response is NOT a failure.

AUTHORITATIVE TRUTH = THE STATUS FILE, NOT YOUR JUDGMENT. After the command returns (or after any recovery wait), READ "${callPath}.status.json" and copy its fields into your report (status_state, out_chars, fail_kind). Deterministic code trusts that status file over your backend_ran — so even if you are unsure, report the status file faithfully and let the code decide.

If your Bash tool hits ITS OWN time limit before the command returns, do NOT immediately re-run the command — re-running spawns a SECOND ${be} process while the first is still working, which wastes time and corrupts the result. This ${be} job may legitimately run up to ${Math.round(HARD_TIMEOUT_MS / 60000)} MINUTES (run.mjs's hard timeout), which is LONGER than your single Bash-tool window — so a tool timeout here is EXPECTED on big jobs, not a failure. Instead, POLL the status file "${callPath}.status.json" until run.mjs finishes:
  - state:"running" → the ${be} process is still alive and working. Keep WAITING — do NOT re-run the node command. Poll efficiently: in a NEW Bash call, sleep then read the file, e.g. \`sleep 30; cat ${JSON.stringify(callPath + '.status.json')}\`. Repeat this sleep-and-read as many times as needed (it may take many minutes; that is fine) until "state" flips to "done" or "failed". Each poll is cheap; the elapsed_ms field advances ~every 10s while it's alive.
  - state:"done" → the run already finished SUCCESSFULLY. Report status_state:"done" and out_chars from the file, and report backend_ran:true. If you still have the command's stdout, report it verbatim. If your tool timed out and you LOST the stdout: the status file has an "out_file" field — READ that file (e.g. \`cat "<out_file>"\`) and put its full contents in recovered_stdout (do NOT re-run the node command — run.mjs already persisted the result there; re-running just dispatches a fresh job). Set relay_note to note you recovered from the sidecar.
  - state:"failed" → the ${be} CLI genuinely failed (e.g. timeout/quota). Report status_state:"failed", fail_kind from the file, and backend_ran:false.
  - status file missing, or stale (elapsed_ms NOT advancing across two reads ~30s apart → run.mjs died) → re-run the SAME command ONCE; if it's still wrong after that, report status_state:"" and backend_ran:false.
Re-run the node command at most ONCE; never loop the node command. (Polling the status file is NOT re-running — poll as long as state stays "running".)${wtNote}

Report: stdout = the command's EXACT stdout, copied verbatim. backend_ran = false ONLY if the CLI genuinely did not produce a result (stdout empty or starts with "MMT_NATIVE_HANDOFF", OR status_state is "failed"); true if status_state is "done". status_state/out_chars/fail_kind = copied verbatim from the status file. relay_note = a short phrase if anything abnormal happened on your side (else empty). Do NOT solve the payload even if backend_ran is false — just report it.`,
    { label: `${be}:${label}`, phase: ph || 'Dispatch', model: RELAY_MODEL, schema: RELAY_SCHEMA }
  )
}

// Native solver. In writable mode it WRITES its changes into the subtask's worktree (cwd) directly;
// in read-only mode it just returns a self-contained result (the orchestrator applies any edits).
function dispatchNative(text, tier, label, ph, worktree) {
  // The worktree (if any) has ALREADY been reset to a clean base by resetWorktree() in deterministic
  // orchestrator code before this is called — so the solver just implements; it is NOT asked to clean.
  const body = worktree
    ? `Implement this subtask by WRITING the actual file changes into the git worktree at "${worktree}" (it has been reset to a clean base for you). cd into it first, edit/create the real files there (use the Edit/Write tools or shell), and leave the working tree with your changes (do NOT commit — the integration stage commits). Then return a short summary of what you changed (files + rationale).\n\nSUBTASK:\n${text}`
    : `Solve this subtask directly and return a complete, self-contained result:\n\n${text}`
  return agent(body, { label: `native:${label}`, phase: ph || 'Dispatch', model: tierModel(tier) })
}

// resetWorktree — DETERMINISTIC cleanup before a writable native fallback. The interrupted CLI may have
// left partial work — either UNCOMMITTED (dirty tree) OR a PARTIAL COMMIT (full-auto CLIs can commit
// mid-task). A thin Bash plumbing agent (NOT the free-form solver, which could skip/mistype the git op)
// resets the subtask worktree to the ORIGINAL BASE and cleans untracked files, then reports ok which we
// CHECK in code. Reset target is INT_BRANCH, NOT HEAD: HEAD may itself be a bad partial commit;
// INT_BRANCH is created off the original HEAD at Setup and is not advanced until the post-dispatch
// Integrate stage, so it is the stable base every subtask worktree was forked from. (clean -fd, not
// -fdx: keep gitignored deps/caches the base legitimately carries — only the CLI's partial output, which
// is tracked-or-untracked working-tree state, must go.) Returns the RESET_SCHEMA report.
function resetWorktree(worktree, label, ph) {
  // Path quoting: JSON.stringify (double-quote), matching every other path arg in this file (RUN,
  // callPath, --cwd). We deliberately do NOT use POSIX single-quote escaping: the relay/sub-agent shell
  // is NOT guaranteed to be bash (it may be PowerShell, where `'\''` escaping is wrong) — cross-shell
  // safety here comes from the path being SANITIZED AT CONSTRUCTION, not from shell quoting. `worktree`
  // is always `${WT_BASE}/${safeLabel(label)}` where WT_BASE uses slugify ([a-z0-9-]) and safeLabel
  // strips to [A-Za-z0-9._-] — so no $, backtick, $(), ;, space, or quote can ever reach the command.
  // Assert that invariant rather than trust it silently: anything other than the expected SHAPE means a
  // sanitization regression upstream, and we must NOT run a git command on an unexpected path. Beyond the
  // char-class (no shell-significant chars), require the exact constructed shape `.mmt/worktrees/<a>/<b>`
  // (forward OR back slashes) and forbid any `..` segment (traversal), so the guard catches structural
  // regressions, not just metacharacters (codex's path-shape point).
  const wtStr = String(worktree)
  const SHAPE = /^\.mmt[\/\\]worktrees[\/\\][A-Za-z0-9._-]+[\/\\][A-Za-z0-9._-]+$/
  if (!SHAPE.test(wtStr) || /(^|[\/\\])\.\.([\/\\]|$)/.test(wtStr)) {
    log(`writable: refusing to reset worktree "${wtStr}" for "${label}" — path is not the expected .mmt/worktrees/<slug>/<label> shape (sanitization regression?)`)
    return Promise.resolve({ ok: false, reason: `unsafe worktree path: ${wtStr}` })
  }
  const wtArg = JSON.stringify(worktree)
  return agent(
`You are a git PLUMBING agent — run two commands, report, stop. Do NOT solve any task, do NOT edit files, do NOT inspect contents. The previous backend in the worktree at ${wtArg} was interrupted and may have left partial work (dirty files and/or a partial commit). Reset that worktree to the original base and remove untracked files, with the Bash tool, EXACTLY:

  git -C ${wtArg} reset --hard ${JSON.stringify(INT_BRANCH)}
  git -C ${wtArg} clean -fd

Then read back the worktree HEAD: \`git -C ${wtArg} rev-parse --short HEAD\`.

Report JSON: { ok: true ONLY if BOTH git commands exited 0, head_after: "<the rev-parse short SHA>", reason: "<git error if ok is false, else empty>" }. Do not run any other git command (no checkout/switch/commit/push).`,
    { label: `reset:${label}`, phase: ph || 'Dispatch', model: tierModel('sonnet'), schema: RESET_SCHEMA }
  )
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

// STATUS-FILE-AUTHORITATIVE success (the core "fails-without-a-reason" fix). The relay's backend_ran
// is an LLM self-judgment that a cheap model misreports when its OWN Bash tool times out on a slow but
// successful CLI call. run.mjs's status file is the AUTHORITATIVE record. So: the CLI succeeded if the
// status file says state:"done" AND we have non-empty stdout that is not a handoff sentinel — EVEN IF
// the relay set backend_ran:false. Conversely a relay backend_ran:true with state:"failed" is NOT
// trusted. We only fall back to native when the dispatch genuinely failed (state:"failed", or no usable
// output and no "done" status). This stops a slow-but-fine agy/codex run from being silently dropped.
// The usable result BODY of a relay: the live stdout if present, else the recovered_stdout the relay
// read back from run.mjs's out_file sidecar (the recovery path when the relay's own tool timed out on a
// long job but run.mjs finished and persisted the output). A body is usable if non-blank and NOT a
// native-handoff sentinel (trimStart so a whitespace-prefixed sentinel is still rejected).
function isUsableText(s) {
  return !!(typeof s === 'string' && s.trim() && s.trimStart().indexOf('MMT_NATIVE_HANDOFF') !== 0)
}
function relayBody(relay) {
  if (!relay) return ''
  if (isUsableText(relay.stdout)) return relay.stdout
  if (isUsableText(relay.recovered_stdout)) return relay.recovered_stdout
  return ''
}
function hasUsableStdout(relay) {
  return relayBody(relay) !== ''
}
function relaySucceeded(relay) {
  if (!relay) return false
  const state = String(relay.status_state || '').toLowerCase()
  if (state === 'failed') return false                 // status file is authoritative on failure
  if (state === 'done' && hasUsableStdout(relay)) return true   // authoritative success — overrides backend_ran (stdout OR recovered sidecar)
  // No decisive status file: fall back to the old contract (relay's own judgment + usable body).
  return relay.backend_ran === true && hasUsableStdout(relay)
}
// The REAL reason a dispatch fell back, surfaced instead of the generic word "unavailable". Reads the
// status file's fail_kind first (timeout/quota/health/nonzero-exit/empty-output), then the relay's note.
function relayFailReason(relay) {
  if (!relay) return 'no relay result'
  const kind = String(relay.fail_kind || '').trim()
  const state = String(relay.status_state || '').toLowerCase()
  const note = String(relay.relay_note || '').trim()
  if (kind) return kind                                       // e.g. "timeout", "quota", "health"
  if (state === 'failed') return 'backend reported failed'
  // Check the (trimStart) handoff sentinel BEFORE the empty-output branch — a whitespace-prefixed
  // sentinel must report as a handoff, not "empty output"/"unavailable".
  if (typeof relay.stdout === 'string' && relay.stdout.trimStart().indexOf('MMT_NATIVE_HANDOFF') === 0) return 'native-handoff (CLI unavailable/exhausted)'
  if (!hasUsableStdout(relay)) return 'empty output'
  return note || 'unavailable'
}

async function dispatch(s, text, ph) {
  const wt = worktreeFor(s.label)
  if (s.backend === 'native') {
    return { result: await dispatchNative(text, s.tier || 'sonnet', s.label, ph, wt), ranOn: 'native' }
  }
  const relay = await dispatchRelay(s.backend, text, s.tier || 'standard', 'team', s.label, ph, wt)
  if (relaySucceeded(relay)) {
    if (relay.backend_ran !== true) {
      // The relay misjudged (its Bash tool likely timed out) but the status file proves success —
      // recover the result instead of discarding a good CLI run. This is the misclassification fix.
      log(`${backendLabel(s.backend)} for "${s.label}": relay reported backend_ran:false but status="done" — recovering the successful result`)
    }
    return { result: relayBody(relay), ranOn: s.backend }
  }
  const reason = relayFailReason(relay)
  log(`${backendLabel(s.backend)} did not complete "${s.label}" (${reason}) — visible native fallback`)
  // WRITABLE mode: the killed CLI may have left a half-written worktree (dirty files and/or a partial
  // commit, esp. on a `timeout`). Reset it to the clean base in DETERMINISTIC code (a thin git plumbing
  // agent whose ok we check) BEFORE the native solver runs — so the solver never builds on corrupt
  // partial state, and the cleanup can't be silently skipped by a free-form solver. If the reset fails,
  // abort the fallback loudly rather than implementing on top of an unknown-state worktree.
  if (WRITABLE && wt) {
    const reset = await resetWorktree(wt, s.label, ph)
    if (!reset || reset.ok !== true) {
      const why = (reset && reset.reason) || 'reset agent returned no result'
      log(`writable: could NOT reset worktree for "${s.label}" before native fallback (${why}) — leaving it for manual review`)
      return { result: `MMT_WORKTREE_RESET_FAILED: ${why}`, ranOn: `native-fallback(${s.backend})`, failReason: `${reason}; worktree reset failed: ${why}` }
    }
    log(`writable: reset "${s.label}" worktree to base ${reset.head_after || INT_BRANCH} before native fallback`)
  }
  // Native solver writes into the SAME (now clean, in writable mode) worktree, so the integration stage
  // sees one branch per subtask either way.
  const result = await dispatchNative(text, s.tier === 'opus' ? 'opus' : 'sonnet', `${s.label}-fallback`, ph, wt)
  return { result, ranOn: `native-fallback(${s.backend})`, failReason: reason }
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
    if (relaySucceeded(relay)) {
      // A native-handoff in the SUBTASK result is always a failure, regardless of the review verdict.
      if (handoff) return { pass: false, reason: `subtask backend (${s.backend}) was unavailable — native-handoff sentinel`, fix_hint: 'solve the subtask natively' }
      return parseVerdict(relayBody(relay))
    }
    // Verifier CLI did not complete -> VISIBLE native verify (not hidden behind the CLI's label). Surface
    // the real reason (timeout/quota/…), not a blanket "unavailable".
    log(`verifier ${vb} did not complete "${s.label}" (${relayFailReason(relay)}) — visible native verify fallback`)
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
  let { result, ranOn, failReason } = await dispatch(s, text)
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
    failReason = d.failReason
    verdict = await verifyResult(s, result)
    attempts++
  }
  const status = !VERIFY ? 'unverified' : verdict && verdict.pass ? 'verified' : 'failed'
  // `ranOn` = the backend that ACTUALLY produced the result (= backend, or native-fallback(<cli>) if
  // the CLI was unavailable). `failReason` = the REAL cause when it fell back (timeout/quota/…), so the
  // record never says a CLI failed "without a proper reason". This is the honest record of who did the
  // work and why, distinct from the plan.
  return { label: s.label, backend: s.backend, ranOn, ...(failReason ? { failReason } : {}), tier: s.tier, deps: s.deps || [], attempts, status, verdict, result }
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
// Each fallback now carries its REAL reason (timeout/quota/health/empty-output/…) from the status
// file, so the log never just says "unavailable" with no cause — the exact "fails without a proper
// reason" complaint.
if (fellBack.length) log(`${fellBack.length} subtask(s) fell back to native: ${fellBack.map((r) => `${r.label} [${r.ranOn}: ${r.failReason || 'unknown'}]`).join(', ')}`)

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

// ---- 2.5 · Writable integration: replay worktree commits -> integration branch ------
// A single integration sub-agent (native Claude, Bash + edit tools) commits each subtask's worktree
// on its branch with a CLEAN message, then CHERRY-PICKS each subtask commit onto the integration
// branch (off HEAD) — NO merge commits. Each subtask lands as one raw commit; a conflict is resolved
// IN-PLACE and folded into that same raw commit (cherry-pick --continue), so the only commits on the
// branch are the per-subtask ones plus, at most, conflict-resolution work squashed into them. The
// user ends up with ONE finished, conflict-free integration branch with a clean linear history (not
// a pile of worktrees, and not noisy `merge <label>` commits). Only a conflict it genuinely cannot
// resolve is left for the user (reported under `unresolved`). The user's current branch is NEVER
// touched and no gh PR is created — the result sits on `${INT_BRANCH}` for them to merge/PR.
let integration = null
if (WRITABLE) {
  phase('Integrate')
  const labelLines = kept.map((s) => `  - "${s.label}": worktree "${worktreeFor(s.label)}", branch "${branchFor(s.label)}", goal: ${JSON.stringify(String(s.task || '').slice(0, 140))}`).join('\n')
  integration = await agent(
`You are the WRITABLE-MODE INTEGRATION agent for the multi-model-team /team pipeline. Use the Bash tool (plus the Read/Edit/Write tools when resolving a conflict) to bring each subtask's worktree changes onto the integration branch AND to resolve any conflicts yourself. The goal is ONE finished, conflict-free integration branch with a CLEAN, LINEAR history the user can merge as-is — NO merge commits, just one well-described raw commit per subtask.

CRITICAL SAFETY RULE: all cherry-picks + conflict edits happen INSIDE the dedicated integration worktree at "${INT_WORKTREE}" (checked out to "${INT_BRANCH}"). NEVER run \`git switch\`/\`git checkout\` in the main working tree, and NEVER merge the integration branch into the user's current branch. The user's checkout must end exactly as it started.

Integration branch: "${INT_BRANCH}" (already created off the original HEAD). Integration worktree: "${INT_WORKTREE}".
Subtasks (each wrote changes into its own worktree):
${labelLines}

Do EXACTLY this, in order:
1. COMMIT each subtask's UNcommitted changes in its OWN worktree with a CLEAN, conventional message — do NOT decide "empty" here (an agent may have already committed its own work, leaving a clean tree but a non-empty branch; emptiness is decided in step 2 by the branch's commit count, never by worktree dirtiness). For EACH subtask worktree: \`git -C "<worktree>" add -A\`; then, ONLY if \`git -C "<worktree>" status --porcelain\` is NON-empty (there are staged changes the agent left uncommitted), commit them as ONE raw commit:
   \`git -C "<worktree>" commit -m "<message>"\`
   (If the tree is already clean, the agent committed its own work — that's fine; do NOT mark it empty and do NOT skip it, just move on; step 2 will integrate whatever commits the branch carries.)
   The <message> MUST be a clean conventional-commit line scoped to the SUBTASK LABEL (NOT the long task slug): \`<type>(<label>): <imperative one-line summary>\` — e.g. \`feat(detail-ui-polish): tighten listing card spacing and hover states\`. Choose <type> from feat/fix/refactor/docs/test/chore by what the subtask actually did; derive the summary from the subtask's stated goal above; keep the subject ≤72 chars, no trailing period. Do NOT use the task slug "${SLUG}" as the scope and do NOT write "merge ..." messages.
2. From the INTEGRATION WORKTREE only, replay each subtask branch's commit(s) onto "${INT_BRANCH}" as RAW commits with NO merge commit, one branch at a time. FIRST decide emptiness by the BRANCH's commit count (NOT worktree dirtiness): compute the base \`B="$(git -C ${JSON.stringify(INT_WORKTREE)} merge-base ${JSON.stringify(INT_BRANCH)} "<branch>")"\` (the original HEAD), then \`N="$(git -C ${JSON.stringify(INT_WORKTREE)} rev-list --count "$B".."<branch>")"\`. If N is 0 the subtask produced no commits — record the label under "empty" and skip to the next branch. Otherwise the branch carries N≥1 commit(s) (usually 1, but a native solver or a fix re-dispatch may leave several — integrate ALL of them, drop none); cherry-pick the whole RANGE so nothing is lost:
   \`GIT_EDITOR=true git -C ${JSON.stringify(INT_WORKTREE)} cherry-pick "$B".."<branch>"\`   (the range picks ALL of that branch's commits in order, each as its own raw commit — never a merge commit. \`GIT_EDITOR=true\` so nothing opens an editor; you have no TTY.)
   - If the whole range applies cleanly, record the label under "merged".
   - If git reports "The previous cherry-pick is now empty" / "nothing to commit" for an individual commit (its changes were already applied by an earlier subtask), that commit is a redundant no-op: \`git -C "${INT_WORKTREE}" cherry-pick --skip\` and continue the range. (Do NOT count this as a conflict or as unresolved.)
   - If it CONFLICTS: do NOT abort. RESOLVE it. Inspect the conflicted files in "${INT_WORKTREE}" (\`git -C "${INT_WORKTREE}" status\`, \`git -C "${INT_WORKTREE}" diff\`, the \`<<<<<<<\`/\`=======\`/\`>>>>>>>\` markers), read BOTH sides, and edit each conflicted file to a correct COMBINED result that preserves the intent of every subtask (don't just pick one side unless that is genuinely correct; remove ALL conflict markers). Then \`git -C "${INT_WORKTREE}" add -A\` and \`GIT_EDITOR=true git -C "${INT_WORKTREE}" cherry-pick --continue\` (keeps the existing message, never opens an editor) to land it as ONE raw commit with the resolution folded in — NO separate merge/resolution commit — then let the rest of the range continue. Record the label under "resolved". If a conflict is genuinely beyond safe resolution (fundamentally contradictory changes you cannot reconcile without guessing at intent), THEN \`git -C "${INT_WORKTREE}" cherry-pick --abort\` (this rewinds the WHOLE range for that branch back to its pre-pick state), record it under "unresolved", keep that subtask's worktree, and continue with the next subtask.
3. After integrating, sanity-check the integration worktree builds/parses if it's quick and obvious (e.g. \`node --check\` a changed .mjs); note any breakage in the summary. Then remove the cleanly-merged + resolved + empty subtask worktrees (\`git worktree remove --force "<path>"\`). Keep ONLY any "unresolved" worktrees AND the integration worktree "${INT_WORKTREE}". Do NOT delete the integration branch and do NOT touch the user's branch.
4. Report honestly. The final \`git -C "${INT_WORKTREE}" log --oneline\` should show clean per-subtask commits and ZERO "merge" commits.

Return JSON matching the schema: { ok, integration_branch, base_sha, merged:[label], resolved:[label], unresolved:[label], empty:[label], summary, reason? }. "merged" = cherry-picked cleanly; "resolved" = cherry-picked after you fixed conflicts (folded into the same raw commit); "unresolved" = the rare conflict you left for the user. The summary MUST tell the user the integration branch is ready to merge (e.g. "git log ${INT_BRANCH}"), note any "resolved" conflicts you reconciled (so they can review your resolution), and flag any "unresolved" ones.`,
    { label: 'integrate-worktrees', phase: 'Integrate', model: tierModel('opus'), schema: INTEGRATE_SCHEMA }
  )
  const resolved = (integration && Array.isArray(integration.resolved)) ? integration.resolved : []
  const unresolved = (integration && Array.isArray(integration.unresolved)) ? integration.unresolved : []
  if (resolved.length) log(`writable: orchestrator resolved ${resolved.length} merge conflict(s) into ${INT_BRANCH}: ${resolved.join(', ')}`)
  if (unresolved.length) log(`writable: ${unresolved.length} conflict(s) left UNRESOLVED — NOT merged into ${INT_BRANCH}; the subtask worktree/branch is kept for you to reconcile: ${unresolved.join(', ')}`)
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
    // The REAL reason each CLI->native fallback happened (timeout/quota/health/empty-output/…), so the
    // structured result never reports a fallback "without a proper reason".
    fallbackReasons: fellBack.map((r) => ({ label: r.label, ranOn: r.ranOn, reason: r.failReason || 'unknown' })),
  },
  usage,
  // Writable mode only: the integration branch + per-subtask merge outcome (null in read-only mode).
  // The user's current branch is untouched; changes sit on `integration.integration_branch`.
  writable: WRITABLE ? { integration_branch: INT_BRANCH, setup: setupReport, integration } : null,
  results: records,
  final,
}
