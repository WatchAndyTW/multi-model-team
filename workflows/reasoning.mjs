export const meta = {
  name: 'mmt-reasoning',
  description: 'Multi-model parallel reasoning (OpenRouter Fusion-like): fan the SAME question out to a panel of models in parallel (native Claude / agy / codex), have a judge compare their answers into structured analysis (consensus / contradictions / unique insights / blind spots), then have a synthesizer produce one unified answer better than any single model’s.',
  phases: [
    { title: 'Panel', detail: 'fan the same question to every panelist in parallel (native solves in-context; CLI via faithful run.mjs relay)' },
    { title: 'Judge', detail: 'compare panel answers into structured analysis: consensus, contradictions, unique insights, blind spots' },
    { title: 'Synthesize', detail: 'write one unified answer incorporating the best of all panel answers' },
  ],
}

// =============================================================================
// mmt-reasoning — the Fusion pipeline as a Workflow: Panel -> Judge -> Synthesize.
// A panelist is a (backend, tier) pair: native Claude (opus/sonnet/haiku), agy (Gemini),
// or codex. Native panelists run as real sub-agents pinned to a model; CLI panelists run
// through the faithful run.mjs relay (a PURE PIPE — never a Claude answer wearing a CLI label).
//
// Determinism: runs under the Workflow runtime, which forbids Date/random APIs (they break
// resume). Nothing here uses them. Vary-by-index is used wherever uniqueness is needed.
// Self-contained: the Workflow runtime has no fs/import — the panel-token alias map is INLINED;
// no project libs are imported.
// Injection-safety: the relay sub-agent WRITES each CLI panelist's payload to a file in .mmt/calls/
// (via the Write tool — never a shell), then passes only the file PATH to run.mjs (--call-file). The
// (untrusted) question text is inert data — it lives in a file, read only in Node, and never appears
// on a command line or as parseable shell text. The path itself is a safe [A-Za-z0-9_/.-] token.
// =============================================================================

// ---- inputs (from Workflow args) -------------------------------------------
// Tolerate args arriving as an object OR a JSON string (callers vary).
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = A || {}
const question = A.question || ''
const root = A.pluginRoot || ''

// ---- reasoning config: roles + defaults are configurable, not hardcoded -----
// Precedence low->high: built-in default < A.reasoningConfig (roster) < top-level A.* (this run).
const RC = (A.reasoningConfig && typeof A.reasoningConfig === 'object') ? A.reasoningConfig : {}
const RELAY_MODEL = A.relayModel || RC.relay_model || 'haiku'        // model the thin relay agents run on
const TIER_MODELS = { cheap: 'haiku', standard: 'sonnet', sonnet: 'sonnet', opus: 'opus', haiku: 'haiku', ...(RC.tier_models || {}) }
const CAP = clampCap(A.cap ?? RC.cap ?? 6)

// ---- inlined panel-token vocabulary (canonical; mirror docs/REASONING.md) ----
// token (incl. aliases) -> { backend, tier }. Unknown tokens are skipped with a note.
const TOKEN_MAP = {
  opus:      { backend: 'native', tier: 'opus' },
  sonnet:    { backend: 'native', tier: 'sonnet' },
  claude:    { backend: 'native', tier: 'sonnet' },
  native:    { backend: 'native', tier: 'sonnet' },
  anthropic: { backend: 'native', tier: 'sonnet' },
  haiku:     { backend: 'native', tier: 'haiku' },
  gemini:    { backend: 'agy', tier: 'standard' },
  agy:       { backend: 'agy', tier: 'standard' },
  pro:       { backend: 'agy', tier: 'standard' },
  google:    { backend: 'agy', tier: 'standard' },
  flash:     { backend: 'agy', tier: 'cheap' },
  codex:     { backend: 'codex', tier: 'standard' },
  openai:    { backend: 'codex', tier: 'standard' },
  gpt:       { backend: 'codex', tier: 'standard' },
  chatgpt:   { backend: 'codex', tier: 'standard' },
}

function clampCap(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(16, Math.floor(n))
}

function tierModel(tier) {
  return TIER_MODELS[tier] || (tier === 'opus' ? 'opus' : 'sonnet')
}

// Resolve "native:opus" / a bare tier / a token into a concrete native model. Default opus.
function resolveModel(spec, fallback) {
  let s = String(spec || fallback || 'opus').trim().toLowerCase()
  if (s.indexOf('native:') === 0) s = s.slice('native:'.length)
  const tok = TOKEN_MAP[s]
  if (tok && tok.backend === 'native') return tierModel(tok.tier)
  return tierModel(s)
}

// Expand one panel token (possibly "N:token" / "token:N") into 0+ {backend,tier,token}.
function expandToken(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return []
  let count = 1
  let tok = s
  const m1 = /^(\d+)\s*:\s*(.+)$/.exec(s)      // "3:gemini"
  const m2 = /^(.+?)\s*:\s*(\d+)$/.exec(s)      // "gemini:3"
  if (m1) { count = parseInt(m1[1], 10); tok = m1[2].trim() }
  else if (m2) { tok = m2[1].trim(); count = parseInt(m2[2], 10) }
  if (!Number.isFinite(count) || count < 1) count = 1
  if (count > 16) count = 16
  const hit = TOKEN_MAP[tok]
  if (!hit) return []
  const out = []
  for (let i = 0; i < count; i++) out.push({ backend: hit.backend, tier: hit.tier, token: tok })
  return out
}

// Resolve the panel: A.panel (token array OR resolved Panelist[]) > RC.panel > default.
// Returns a unique-labelled Panelist[] clamped to CAP.
function resolvePanel() {
  let src = A.panel
  if (!Array.isArray(src) || !src.length) src = Array.isArray(RC.panel) && RC.panel.length ? RC.panel : ['opus', 'sonnet', 'gemini']

  // Already-resolved Panelist[] (objects with a backend) vs token strings.
  let panelists = []
  if (src.length && typeof src[0] === 'object' && src[0] && src[0].backend) {
    panelists = src.map((p) => ({
      backend: p.backend === 'agy' || p.backend === 'codex' ? p.backend : 'native',
      tier: String(p.tier || (p.backend === 'native' ? 'sonnet' : 'standard')),
      token: p.token != null ? String(p.token) : '',
    }))
  } else {
    for (const t of src) panelists.push(...expandToken(t))
  }

  // Clamp to CAP, then assign unique labels.
  panelists = panelists.slice(0, CAP)
  const seen = new Set()
  return panelists.map((p, i) => {
    let base = String(p.token || p.backend || `p${i + 1}`)
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `p${i + 1}`
    let lab = base
    let n = 2
    while (seen.has(lab)) { lab = `${base}-${n}`; n++ }
    seen.add(lab)
    return { backend: p.backend, tier: p.tier, label: lab }
  })
}

const JUDGE_MODEL = resolveModel(A.judge || RC.judge, 'opus')
const SYNTH_MODEL = resolveModel(A.synthesizer || RC.synthesizer, 'opus')

if (!question || !String(question).trim()) {
  return { error: 'mmt-reasoning: no question provided in args.question' }
}
if (!root) {
  return { error: 'mmt-reasoning: args.pluginRoot is required to locate src/bin/run.mjs' }
}

const RUN = `${root}/src/bin/run.mjs`

const panel = resolvePanel()
if (!panel.length) {
  return { error: 'mmt-reasoning: panel resolved to zero panelists' }
}

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
// command-line length limit applies anymore (the payload isn't on the command line).
//
// Determinism: the Workflow runtime forbids Date/random APIs and has no fs — so the call id is
// derived from the (unique) panelist label + a monotonic counter, NOT random; the file is written by
// the sub-agent, not this script.
let _callSeq = 0
function callFilePath(label) {
  const safe = String(label || 'call').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'call'
  return `.mmt/calls/${safe}-${++_callSeq}.json`
}

// ---- schemas ----------------------------------------------------------------

// The faithful CLI relay schema (copied from team.mjs). The relay sub-agent runs ONE command and
// reports {stdout, backend_ran} — it does NOT solve, analyze, or answer the payload itself.
const RELAY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stdout: { type: 'string', description: "the command's EXACT stdout, copied verbatim — never summarized, rewritten, or answered by you" },
    backend_ran: { type: 'boolean', description: 'false if that stdout is empty or begins with MMT_NATIVE_HANDOFF (the CLI was unavailable/exhausted); true otherwise' },
  },
  required: ['stdout', 'backend_ran'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    consensus: { type: 'array', items: { type: 'string' }, description: 'points most/all panelists agree on (higher confidence)' },
    contradictions: { type: 'array', items: { type: 'string' }, description: 'points where panelists directly disagree' },
    unique_insights: { type: 'array', items: { type: 'string' }, description: 'valuable points raised by only a single panelist' },
    blind_spots: { type: 'array', items: { type: 'string' }, description: 'relevant aspects NO panelist addressed' },
    notes: { type: 'string', description: 'optional extra observations' },
  },
  required: ['consensus', 'contradictions', 'unique_insights', 'blind_spots'],
}

// ---- faithful CLI relay (copied from team.mjs, rule:'reason') ----------------
// A non-native backend is reached ONLY by shelling out to run.mjs (forced decision, native:false).
// The relay sub-agent runs that one command and reports {stdout, backend_ran} — never its own answer.
// Deterministic code (the caller) decides the fallback, so a CLI-unavailable panelist is re-dispatched
// as a VISIBLE native agent, never a Claude analysis wearing a gemini:/codex: label.
function dispatchRelay(backend, text, tier, rule, label, ph) {
  const be = backendLabel(backend)
  // File-based transport: the relay sub-agent writes the payload (decision + question) to a JSON file
  // under .mmt/calls/ with the Write tool, then runs `node run.mjs --call-file=<path>`. No heredoc, no
  // quoted JSON, no untrusted text on the command line — works verbatim whether the relay runs in
  // PowerShell or bash. run.mjs reads the file in Node. The call id is derived from the label (the
  // Workflow runtime forbids random/Date), so each panelist gets its own file.
  const callPath = callFilePath(label)
  const callJson = JSON.stringify({ decision: { backend, model: '', tier, rule, native: false }, task: text }, null, 2)

  return agent(
`You are a PURE RELAY PIPE for the ${be} backend — NOT a problem solver. Write one file, run ONE command, report its output, stop. Do NOT browse, reason about, or answer the payload yourself; you have no opinion on its content and must never put your own answer in the output.

Step 1 — with the Write tool (NOT a shell command), write EXACTLY this content to the file at the relative path "${callPath}" (the Write tool creates parent directories):

${callJson}

Step 2 — run EXACTLY this with the Bash tool and nothing else. The payload is in the file you just wrote; only its PATH is on the command line (inert, safe in any shell). Do NOT inline or echo the payload:

node ${JSON.stringify(RUN)} --call-file=${JSON.stringify(callPath)}

CRITICAL — run it in the FOREGROUND and WAIT for it to finish. The ${be} CLI can legitimately take several minutes; run.mjs blocks until it completes (it has its own generous timeout). Do NOT background it (no \`&\`, no \`run_in_background\`), do NOT wrap it in your own \`sleep\`/\`timeout\`/\`tail -f\`, and do NOT give up early — a slow response is NOT a failure. If your Bash tool reports its own time limit, simply run the SAME command again and keep waiting; run.mjs prints a "[mmt] backend still running (Ns)…" heartbeat to stderr and writes a status file next to the call file ("<the call-file path>.status.json", {state:"running"|"done"|"failed"}) you can read to confirm it is still alive.

Report: stdout = the command's EXACT stdout, copied verbatim. backend_ran = false if that stdout is empty or begins with "MMT_NATIVE_HANDOFF" (the ${be} CLI was unavailable/exhausted), true otherwise. Do NOT solve the payload even if backend_ran is false — just report it.`,
    { label: `${be}:${label}`, phase: ph || 'Panel', model: RELAY_MODEL, schema: RELAY_SCHEMA }
  )
}

// A native panelist answers the question directly at its tier's model.
function panelNative(text, tier, label, ph) {
  return agent(
`Answer this question directly, thoroughly, and self-containedly. This is your independent take — it will be compared against other models' answers and synthesized.

QUESTION:
${text}`,
    { label: `native:${label}`, phase: ph || 'Panel', model: tierModel(tier) }
  )
}

// Dispatch one panelist. Returns { label, backend, ranOn, tier, answer }.
async function runPanelist(p) {
  if (p.backend === 'native') {
    const answer = await panelNative(question, p.tier || 'sonnet', p.label, 'Panel')
    return { label: p.label, backend: p.backend, ranOn: 'native', tier: p.tier, answer }
  }
  const relay = await dispatchRelay(p.backend, question, p.tier || 'standard', 'reason', p.label, 'Panel')
  if (relay && relay.backend_ran === true && typeof relay.stdout === 'string' && relay.stdout.trim()) {
    return { label: p.label, backend: p.backend, ranOn: p.backend, tier: p.tier, answer: relay.stdout }
  }
  // CLI unavailable/exhausted -> VISIBLE native fallback (never a Claude answer wearing a CLI label).
  log(`${backendLabel(p.backend)} unavailable for "${p.label}" — visible native fallback`)
  const answer = await panelNative(question, p.tier === 'opus' ? 'opus' : 'sonnet', `${p.label}-fallback`, 'Panel')
  return { label: p.label, backend: p.backend, ranOn: `native-fallback(${p.backend})`, tier: p.tier, answer }
}

// ---- 1 · Panel — fan the SAME question to every panelist in parallel --------
phase('Panel')
const panelists = (await parallel(panel.map((p) => () => runPanelist(p)))).filter(Boolean)

const fellBack = panelists.filter((r) => typeof r.ranOn === 'string' && r.ranOn.indexOf('native-fallback') === 0)
if (fellBack.length) log(`${fellBack.length} panelist(s) fell back to native (CLI unavailable): ${fellBack.map((r) => `${r.label} [${r.ranOn}]`).join(', ')}`)

// ---- usage accounting -------------------------------------------------------
// The Workflow runtime can't read per-agent token counts (those arrive in the run notification's
// aggregate `subagent_tokens`), but it knows WHO answered each panelist. CLI panelists ran on
// agy/codex (OFF Claude's token budget — only the thin relay agent spent native tokens); native
// panelists (incl. native-fallbacks), the judge, and the synthesizer ran on Claude (ON the budget).
// Answer char counts are a concrete size proxy. The orchestrator folds the notification's
// `subagent_tokens` total into this split when reporting to the user.
function approxChars(r) { return typeof r.answer === 'string' ? [...r.answer].length : 0 }
const cliPanelists = panelists.filter((r) => r.ranOn === 'agy' || r.ranOn === 'codex')
const nativePanelists = panelists.filter((r) => r.ranOn === 'native' || (typeof r.ranOn === 'string' && r.ranOn.indexOf('native-fallback') === 0))
const usage = {
  note: 'Per-agent token counts are not visible inside the workflow; see the run notification\'s aggregate subagent_tokens. This is the executor split + output-size proxy.',
  cli: {
    panelists: cliPanelists.length,
    byBackend: Object.fromEntries(['agy', 'codex'].map((b) => [b, panelists.filter((r) => r.ranOn === b).length]).filter(([, n]) => n > 0)),
    output_chars: cliPanelists.reduce((n, r) => n + approxChars(r), 0),
    comment: 'ran on the CLI backend — off Claude\'s token budget (only the relay agent spent native tokens)',
  },
  native: {
    panelists: nativePanelists.length,
    fallbacks: fellBack.length,
    output_chars: nativePanelists.reduce((n, r) => n + approxChars(r), 0),
    comment: 'ran on native Claude — on the token budget (includes CLI->native fallbacks)',
  },
  relay_agents: cliPanelists.length,                 // one thin relay agent per CLI panelist (RELAY_MODEL)
  orchestration_agents: panelists.length > 1 ? 2 : 0, // judge + synthesizer (skipped on a single-panelist run)
}
if (cliPanelists.length) log(`usage: ${cliPanelists.length} panelist(s) on CLI (off-budget); ${nativePanelists.length} on native Claude`)

// Single-panelist run degenerates to one answer with no judge/synthesis.
if (panelists.length === 1) {
  const only = panelists[0]
  return {
    question,
    panel: panel.map((p) => ({ label: p.label, backend: p.backend, tier: p.tier })),
    judge: null,
    synthesizer: SYNTH_MODEL,
    counts: {
      byBackend: Object.fromEntries([...new Set(panel.map((p) => p.backend))].map((b) => [b, panel.filter((x) => x.backend === b).length])),
      ranOn: Object.fromEntries([...new Set(panelists.map((r) => r.ranOn))].map((k) => [k, panelists.filter((r) => r.ranOn === k).length])),
      nativeFallbacks: fellBack.length,
    },
    usage,
    panelists: panelists.map((r) => ({ label: r.label, backend: r.backend, ranOn: r.ranOn, answer: r.answer })),
    final: only.answer,
  }
}

// Labelled transcript of every panelist's answer (which model produced what).
const transcript = panelists
  .map((r) => `### Panelist "${r.label}" (${backendLabel(r.backend)}/${r.tier}${r.ranOn !== r.backend ? `, ran on ${r.ranOn}` : ''})\n${r.answer}`)
  .join('\n\n')

// ---- 2 · Judge — structured comparison of the panel ------------------------
phase('Judge')
const judge = await agent(
`You are a JUDGE comparing several models' independent answers to the SAME question. Produce a structured analysis. Be precise and attribute by panelist label where useful.
- consensus: points most/all panelists agree on (treat as higher-confidence).
- contradictions: points where panelists directly disagree (state both sides).
- unique_insights: valuable points raised by only ONE panelist.
- blind_spots: relevant aspects that NO panelist addressed.

QUESTION:
${question}

PANEL ANSWERS:
${transcript}`,
  { label: 'judge', phase: 'Judge', model: JUDGE_MODEL, schema: JUDGE_SCHEMA }
)

// ---- 3 · Synthesize — one unified answer better than any single one --------
phase('Synthesize')
const final = await agent(
`Synthesize ONE unified, complete answer to the question that is better than any single panelist's. Prefer the consensus, fold in the unique insights, address the blind spots, and resolve the contradictions explicitly (don't paper over them). Write the final answer directly — do not narrate the process.

QUESTION:
${question}

PANEL ANSWERS:
${transcript}

JUDGE ANALYSIS (JSON):
${JSON.stringify(judge, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', model: SYNTH_MODEL }
)

return {
  question,
  panel: panel.map((p) => ({ label: p.label, backend: p.backend, tier: p.tier })),
  judge,
  synthesizer: SYNTH_MODEL,
  counts: {
    byBackend: Object.fromEntries([...new Set(panel.map((p) => p.backend))].map((b) => [b, panel.filter((x) => x.backend === b).length])),
    ranOn: Object.fromEntries([...new Set(panelists.map((r) => r.ranOn))].map((k) => [k, panelists.filter((r) => r.ranOn === k).length])),
    nativeFallbacks: fellBack.length,
  },
  usage,
  panelists: panelists.map((r) => ({ label: r.label, backend: r.backend, ranOn: r.ranOn, answer: r.answer })),
  final,
}
