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
// Injection-safety: CLI panelists ride to run.mjs as base64url args (--task-b64/--decision-b64), so
// the (untrusted) question text is inert data, decoded only in Node and never parsed by a shell.
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
// encoded command length and fall back to a VISIBLE native panelist for an oversized payload rather
// than spawn a relay whose command line would be truncated (which would silently misdispatch).
const MAX_RELAY_ARG_CHARS = 28000

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
  panelists: panelists.map((r) => ({ label: r.label, backend: r.backend, ranOn: r.ranOn, answer: r.answer })),
  final,
}
