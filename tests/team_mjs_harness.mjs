#!/usr/bin/env node
// team_mjs_harness.mjs — deterministically exercise workflows/team.mjs WITHOUT a live model.
//
//   node tests/team_mjs_harness.mjs [path/to/team.mjs] ['<teamConfig JSON>']
//
// team.mjs is a Workflow-runtime script (top-level await + `return`, injected globals
// `agent`/`parallel`/`phase`/`log`/`args`), so it can't be imported directly. We read its source,
// strip the `export`, and run the body inside an AsyncFunction with stubbed globals. The stub feeds
// a 3-subtask plan — ONE per backend (native, agy, codex), chained by deps — so it proves the
// EQUAL-tools contract: every backend is a real dispatch target (codex is NOT just the verifier),
// any backend can be the verifier, and tier->model is honored. Arg #2 is an optional teamConfig
// JSON (the roster `team` section); the harness derives the expected wiring from it and asserts:
//   - applied per-backend caps + counts.byBackend, dependency-ordered context injection, one fix,
//   - each subtask dispatched on its (post-coercion) backend with that backend's label prefix,
//   - the verify relay targets the configured verifier backend (or stays native), and
//   - tier->model took effect (native subtask not silently inheriting the main-loop model).
// Prints "HARNESS_OK ..." on success; exits 1 with a reason on any failed check.

import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'workflows', 'team.mjs')
let tc = {}
if (process.argv[3]) {
  try { tc = JSON.parse(process.argv[3]) } catch (e) { console.error('HARNESS_BAD bad teamConfig JSON: ' + e.message); process.exit(1) }
}

let src
try {
  src = fs.readFileSync(file, 'utf8')
} catch (e) {
  console.error('HARNESS_BAD cannot read team.mjs: ' + e.message)
  process.exit(1)
}
const body = src.replace(/^\s*export\s+const\s+meta/m, 'const meta')

// Expected wiring derived from the (merged) config — mirrors team.mjs's own logic.
const KNOWN = ['agy', 'codex', 'native']
const backendLabel = (b) => (b === 'agy' ? 'gemini' : String(b || ''))
let DISPATCH = (Array.isArray(tc.dispatch_backends) && tc.dispatch_backends.length ? tc.dispatch_backends.map(String) : ['agy', 'codex', 'native']).filter((b) => KNOWN.includes(b))
if (!DISPATCH.includes('native')) DISPATCH.push('native')
DISPATCH = [...new Set(DISPATCH)]
const eff = (planned) => (DISPATCH.includes(planned) ? planned : 'native') // post-coercion backend
const verifier = tc.verifier || 'codex'
const verifyIsNative = verifier === 'native'
const verifyPrefix = verifyIsNative ? 'native' : backendLabel(verifier)
const expectSonnetModel = (tc.tier_models && tc.tier_models.sonnet) || 'sonnet'
const expectRelayModel = tc.relay_model || 'sonnet'

// stub plan: one subtask per backend, chained by deps (native -> agy -> codex).
const PLAN = [
  { label: 'model', task: 'design the data model', backend: 'native', tier: 'sonnet', deps: [], verify: 'schema present' },
  { label: 'sql', task: 'write the SQL report', backend: 'agy', tier: 'standard', deps: ['model'], verify: 'valid SQL' },
  { label: 'tests', task: 'write tests for the report', backend: 'codex', tier: 'standard', deps: ['sql'], verify: 'tests cover joins' },
]
const plannedOf = Object.fromEntries(PLAN.map((s) => [s.label, s.backend]))  // label -> planned backend

// ---- stubs ------------------------------------------------------------------
const calls = { dispatch: [], verify: [], phases: [] }
let sawUpstreamContext = false
let sawVerifyRelay = false
let verifyDecisionBackend = ''
const verifyLabels = []
const models = {}
const verifyCount = {}

// MMT_HARNESS_CLI_DOWN=1 simulates EVERY CLI backend being unavailable, so the faithful relay reports
// backend_ran=false and the workflow must fall back to a VISIBLE native: agent (regression for the bug
// where a CLI-labelled agent silently produced Claude output instead of relaying).
const CLI_DOWN = process.env.MMT_HARNESS_CLI_DOWN === '1'

// bare subtask name from any label: strip the backend prefix, a `-fallback` suffix, and a `#fixN` tag.
function bareOf(label) {
  return String(label).replace(/^[a-z]+:/, '').replace(/-fallback$/, '').replace(/#fix\d+$/, '')
}
function cannedResult(bare, prompt) {
  if (bare === 'model') return 'MODEL_RESULT_AABBCC'
  if (bare === 'sql') { if (prompt.includes('MODEL_RESULT_AABBCC')) sawUpstreamContext = true; return 'SQL_RESULT_DDEEFF' }
  if (bare === 'tests') return 'TESTS_RESULT_112233'
  return 'GENERIC_RESULT'
}

async function agentStub(prompt, opts = {}) {
  const label = String(opts.label || '')
  const schema = opts.schema || null
  const props = (schema && schema.properties) || {}
  if (label) models[label] = opts.model

  // 1) Decompose
  if (props.subtasks || label === 'decompose') {
    return { subtasks: PLAN.map((s) => ({ ...s })) }
  }

  // 2) Verify RELAY — a PURE PIPE to a CLI verifier. Returns {stdout, backend_ran}; the workflow
  //    parses the PASS/FAIL verdict deterministically (it does NOT re-judge). Detected by the relay
  //    schema (props.stdout) + a `*:verify:*` label.
  if (props.stdout && /verify:/.test(label)) {
    const m = label.match(/verify:(.+)$/)
    const who = m ? m[1] : 'unknown'
    verifyCount[who] = (verifyCount[who] || 0) + 1
    calls.verify.push(who)
    verifyLabels.push(label)
    const dm = prompt.match(/"backend":"([^"]+)"[^}]*"rule":"team-verify"/)
    if (dm) { sawVerifyRelay = true; verifyDecisionBackend = dm[1] }
    if (CLI_DOWN) return { stdout: 'MMT_NATIVE_HANDOFF tier=standard rule=team-verify reason="down"', backend_ran: false }
    if (who === 'sql' && verifyCount[who] === 1) return { stdout: 'FAIL\nmissing GROUP BY\nadd a GROUP BY clause', backend_ran: true }
    return { stdout: 'PASS\nlooks correct', backend_ran: true }
  }

  // 3) Native verify — verifier:'native', OR the VISIBLE fallback when a CLI verifier is down.
  if (props.pass || /verify:/.test(label)) {
    const m = label.match(/verify:(.+)$/)
    const who = m ? m[1] : 'unknown'
    verifyCount[who] = (verifyCount[who] || 0) + 1
    calls.verify.push(who)
    verifyLabels.push(label)
    if (who === 'sql' && verifyCount[who] === 1) return { pass: false, reason: 'missing GROUP BY', fix_hint: 'add a GROUP BY clause' }
    return { pass: true, reason: 'looks correct', fix_hint: '' }
  }

  // 4) Dispatch RELAY — a PURE PIPE to a CLI backend. Returns {stdout, backend_ran}; the workflow
  //    decides any fallback. When CLI_DOWN, report the handoff sentinel + backend_ran=false.
  if (props.stdout) {
    calls.dispatch.push(label)
    if (CLI_DOWN) return { stdout: 'MMT_NATIVE_HANDOFF tier=standard rule=team reason="down"', backend_ran: false }
    return { stdout: cannedResult(bareOf(label), prompt), backend_ran: true }
  }

  // 5) Native dispatch / fix / native fallback — match on the BARE subtask name.
  calls.dispatch.push(label)
  if (label === 'synthesize') return 'FINAL_SYNTHESIS'
  return cannedResult(bareOf(label), prompt)
}

async function parallelStub(thunks) {
  return Promise.all(
    (thunks || []).map((t) => {
      try {
        return Promise.resolve(t()).catch(() => null)
      } catch (e) {
        return null
      }
    })
  )
}
async function pipelineStub(items, ...stages) {
  const out = []
  for (let i = 0; i < (items || []).length; i++) {
    let v = items[i]
    for (const st of stages) {
      try {
        v = await st(v, items[i], i)
      } catch (e) {
        v = null
        break
      }
    }
    out.push(v)
  }
  return out
}
const phaseStub = (t) => calls.phases.push(t)
const logStub = () => {}

const stubArgs = {
  task: 'build a small reporting feature',
  pluginRoot: '/fake/plugin/root',
  teamConfig: tc,
}

// ---- run --------------------------------------------------------------------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let out
try {
  const fn = new AsyncFunction('args', 'helpers', `const { agent, parallel, pipeline, phase, log } = helpers;\n${body}`)
  out = await fn(stubArgs, { agent: agentStub, parallel: parallelStub, pipeline: pipelineStub, phase: phaseStub, log: logStub })
} catch (e) {
  console.error('HARNESS_BAD execution threw: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
}

// ---- assert -----------------------------------------------------------------
const fails = []
const ck = (cond, msg) => { if (!cond) fails.push(msg) }

// CLI-DOWN regression: when every CLI backend is unavailable, NO work may be silently done behind a
// CLI label — each non-native subtask must be re-dispatched to a VISIBLE native: fallback agent, and
// its record must say so (ranOn = native-fallback(<cli>)). This is the exact bug being fixed.
if (CLI_DOWN) {
  ck(out && typeof out === 'object', 'down: no result object')
  ck(!out.error, 'down: unexpected error: ' + (out && out.error))
  ck(out.final === 'FINAL_SYNTHESIS', 'down: expected synthesized final, got ' + (out && out.final))
  const nonNative = PLAN.filter((s) => eff(s.backend) !== 'native')
  for (const s of nonNative) {
    ck(calls.dispatch.some((l) => l.startsWith(backendLabel(eff(s.backend)) + ':' + s.label)), `down: ${s.label} CLI relay not even ATTEMPTED before fallback`)
    ck(calls.dispatch.some((l) => l.startsWith('native:' + s.label + '-fallback')), `down: ${s.label} got no VISIBLE native fallback agent`)
    const rec = out.results.find((r) => r.label === s.label)
    ck(rec && typeof rec.ranOn === 'string' && rec.ranOn.indexOf('native-fallback(') === 0, `down: ${s.label} ranOn should be native-fallback(...), got ` + (rec && rec.ranOn))
  }
  ck(out.counts && out.counts.nativeFallbacks === nonNative.length, `down: counts.nativeFallbacks expected ${nonNative.length}, got ` + (out.counts && out.counts.nativeFallbacks))
  if (fails.length) { console.error('HARNESS_BAD\n - ' + fails.join('\n - ')); process.exit(1) }
  console.log(`HARNESS_OK_FALLBACK fellBack=${nonNative.length} visible=native verified=${out.counts.verified}`)
  process.exit(0)
}

ck(out && typeof out === 'object', 'no result object returned')
ck(!out.error, 'unexpected error: ' + (out && out.error))
ck(out.final === 'FINAL_SYNTHESIS', 'expected synthesized final, got ' + out.final)
ck(out.counts && out.counts.failed === 0, 'expected counts.failed=0, got ' + (out.counts && out.counts.failed))
ck(out.counts && out.counts.verified === 3, 'expected counts.verified=3, got ' + (out.counts && out.counts.verified))

// Per-backend counts reflect the EFFECTIVE (post-coercion) backend of each planned subtask.
const effList = PLAN.map((s) => eff(s.backend))
const expCounts = {}
for (const b of DISPATCH) expCounts[b] = effList.filter((x) => x === b).length
for (const b of DISPATCH) {
  ck(out.counts && out.counts.byBackend && out.counts.byBackend[b] === expCounts[b], `counts.byBackend.${b} expected ${expCounts[b]}, got ` + (out.counts && out.counts.byBackend && out.counts.byBackend[b]))
}

// Every subtask was dispatched on its effective backend, with that backend's label prefix.
for (const s of PLAN) {
  const pref = backendLabel(eff(s.backend))
  ck(calls.dispatch.some((l) => l.startsWith(pref + ':' + s.label)), `subtask ${s.label} not dispatched as ${pref}:${s.label} (backend equality broken)`)
}
// codex must be a real DISPATCH target when eligible (the user's core point: not verify-only).
if (DISPATCH.includes('codex')) {
  ck(calls.dispatch.some((l) => l.startsWith('codex:tests')), 'codex was eligible but never used as a dispatch backend')
}

// ranOn records the backend that ACTUALLY produced each result (here every backend "ran" — no fallback).
for (const s of PLAN) {
  const rec = out.results.find((r) => r.label === s.label)
  ck(rec && rec.ranOn === eff(s.backend), `ranOn for ${s.label} expected ${eff(s.backend)}, got ` + (rec && rec.ranOn))
}

ck(sawUpstreamContext, 'dependency context NOT injected (sql never saw model result)')

// Verifier is whatever the config says — any backend, or native.
if (verifyIsNative) {
  ck(!sawVerifyRelay, 'verifier=native must NOT shell out to a verify backend')
  ck(verifyLabels.length > 0 && verifyLabels.every((l) => l.startsWith('native:verify:')), 'native verify labels should all be native:verify:*, got ' + verifyLabels.join(','))
} else {
  ck(sawVerifyRelay && verifyDecisionBackend === verifier, `verify relay should target backend "${verifier}", got "${verifyDecisionBackend || '(none)'}"`)
  ck(verifyLabels.some((l) => l.startsWith(verifyPrefix + ':verify:')), `no verify label prefixed \`${verifyPrefix}:verify:\``)
}

// Tier -> model mapping took effect (native subtask not silently inheriting the main-loop model).
ck(models['native:model'] === expectSonnetModel, `native sonnet-tier subtask should run on model=${expectSonnetModel}, got ` + models['native:model'])
const sqlBe = backendLabel(eff('agy'))
const sqlModel = eff('agy') === 'native' ? expectSonnetModel : expectRelayModel
ck(models[sqlBe + ':sql'] === sqlModel, `sql (${sqlBe}) should run on model=${sqlModel}, got ` + models[sqlBe + ':sql'])

// dependency wave ordering: model before sql before tests.
const idx = (name) => calls.dispatch.findIndex((l) => l.replace(/^[a-z]+:/, '').replace(/#fix\d+$/, '') === name)
ck(idx('model') >= 0 && idx('sql') > idx('model'), 'model not dispatched before sql (wave ordering broken)')
ck(idx('tests') > idx('sql'), 'sql not dispatched before tests (wave ordering broken)')

// the fix re-dispatch must have happened (sql failed verify once).
ck(calls.dispatch.some((l) => l.includes('#fix')), 'no fix re-dispatch observed')

if (fails.length) {
  console.error('HARNESS_BAD\n - ' + fails.join('\n - '))
  process.exit(1)
}
const codexDispatch = DISPATCH.includes('codex') ? ' codexDispatch=ok' : ''
console.log(`HARNESS_OK verifier=${verifyIsNative ? 'native' : verifier} backends=${DISPATCH.join('+')} verified=3 fixLoop=1${codexDispatch}`)
