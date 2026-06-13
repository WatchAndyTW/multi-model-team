export const meta = {
  name: 'mmt-team',
  description: 'Decompose a task; fan out commodity subtasks to parallel agy (Gemini) agents and judgment subtasks to native Claude agents under caps; then synthesize.',
  phases: [
    { title: 'Decompose', detail: 'split the task into backend-assigned subtasks' },
    { title: 'Dispatch', detail: 'agy subtasks via run.sh + native subtasks in parallel' },
    { title: 'Synthesize', detail: 'merge results into one answer' },
  ],
}

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

if (!task || !String(task).trim()) {
  return { error: 'mmt-team: no task provided in args.task' }
}
if (!root) {
  return { error: 'mmt-team: args.pluginRoot is required to locate scripts/run.sh' }
}
if (G + C === 0) {
  return { error: 'mmt-team: caps sum to 0 — no agents available to dispatch' }
}

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
          label: { type: 'string', description: 'short kebab name' },
          task: { type: 'string', description: 'full self-contained subtask text' },
          backend: { type: 'string', enum: ['agy', 'native'] },
          tier: { type: 'string', enum: ['cheap', 'standard', 'sonnet', 'opus'] },
        },
        required: ['label', 'task', 'backend', 'tier'],
      },
    },
  },
  required: ['subtasks'],
}

// ---- 1 · Decompose ----------------------------------------------------------
phase('Decompose')
const plan = await agent(
`Decompose this task into independent subtasks for a multi-model team, and assign each a backend.

Backend rules:
- "agy"  = commodity / verifiable / Gemini-edge work: new components, CSS/UI, scaffolding, CRUD, scripts, SQL, regex, configs, unit tests, data transforms, web-research / doc-summary, audio/video. tier = "standard" (or "cheap" for tiny/bulk).
- "native" = judgment / codebase-context / hard-to-verify work, AND the hard line — RE, IL2CPP/protobuf-RE, disasm, FFI/unsafe, injection, concurrency, protocol design — which must NEVER be "agy". tier = "sonnet" (or "opus" for the hard line).

Use AT MOST ${G} agy subtasks and AT MOST ${C} native subtasks. Prefer fewer, well-scoped subtasks; a trivial task is a single subtask. Each subtask's "task" must be self-contained.

TASK:
${task}`,
  { label: 'decompose', phase: 'Decompose', schema: PLAN_SCHEMA }
)

const subtasks = ((plan && plan.subtasks) || []).filter((s) => s && s.task && String(s.task).trim())
// Coerce tier per backend so a forced agy decision never carries a tier run.sh can't map.
for (const s of subtasks) {
  if (s.backend === 'agy') s.tier = s.tier === 'cheap' ? 'cheap' : 'standard'
  else s.tier = s.tier === 'opus' ? 'opus' : 'sonnet'
}
const agyAll = subtasks.filter((s) => s.backend === 'agy')
const natAll = subtasks.filter((s) => s.backend !== 'agy')
const agySubs = agyAll.slice(0, G)
const natSubs = natAll.slice(0, C)
if (agyAll.length > G) log(`dropping ${agyAll.length - G} agy subtask(s) over cap ${G}`)
if (natAll.length > C) log(`dropping ${natAll.length - C} native subtask(s) over cap ${C}`)
log(`decomposed: ${agySubs.length} agy + ${natSubs.length} native (caps ${G}/${C})`)

// ---- 2 · Dispatch (parallel) ------------------------------------------------
phase('Dispatch')
const RUN = root ? `${root}/scripts/run.sh` : 'run.sh'

const thunks = []
for (let i = 0; i < agySubs.length; i++) {
  const s = agySubs[i]
  const label = s.label || `agy${i}`
  const tier = s.tier || 'standard'
  thunks.push(() =>
    agent(
`You are a relay — do NOT solve the subtask yourself unless told to. Delegate it to the agy (Gemini) backend and return ONLY its output.

Run exactly this with the Bash tool — the subtask rides in on a single-quoted heredoc, so it is inert data and is never parsed by the shell (if the subtask happens to contain the line MMT_SUB_EOF, pick a different unique delimiter):

bash ${JSON.stringify(RUN)} --decision '{"backend":"agy","model":"","tier":"${tier}","rule":"team","native":false}' <<'MMT_SUB_EOF'
${s.task}
MMT_SUB_EOF

Return the command's stdout verbatim. If it begins with "MMT_NATIVE_HANDOFF" (agy was unavailable), THEN solve the subtask yourself and return that result instead.`,
      { label: `agy:${label}`, phase: 'Dispatch' }
    ).then((r) => ({ backend: 'agy', label, tier, result: r }))
  )
}
for (let i = 0; i < natSubs.length; i++) {
  const s = natSubs[i]
  const label = s.label || `native${i}`
  const tier = s.tier || 'sonnet'
  thunks.push(() =>
    agent(
`Solve this subtask directly and return a complete, self-contained result:\n\n${s.task}`,
      { label: `native:${label}`, phase: 'Dispatch' }
    ).then((r) => ({ backend: 'native', label, tier, result: r }))
  )
}

const results = (await parallel(thunks)).filter(Boolean)

// ---- 3 · Synthesize ---------------------------------------------------------
phase('Synthesize')
const final = await agent(
`Synthesize these subtask results into one coherent, complete answer to the original task.
Reconcile overlaps, resolve conflicts, and note which parts ran on Gemini (agy) vs native Claude.

ORIGINAL TASK:
${task}

SUBTASK RESULTS (JSON):
${JSON.stringify(results, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return {
  task,
  caps: { gemini: G, claude: C },
  plan: subtasks,
  agy: agySubs.length,
  native: natSubs.length,
  results,
  final,
}
