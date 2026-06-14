#!/usr/bin/env node
// team_mjs_harness.mjs — deterministically exercise workflows/team.mjs WITHOUT a live model.
//
//   node tests/team_mjs_harness.mjs [path/to/team.mjs]
//
// team.mjs is a Workflow-runtime script (top-level await + `return`, injected globals
// `agent`/`parallel`/`phase`/`log`/`args`), so it can't be imported directly. We read its
// source, strip the `export`, and run the body inside an AsyncFunction with stubbed globals.
// The stubs feed a 2-subtask plan with a dependency (sql depends on model) and force ONE
// verify failure on `sql` so the bounded fix loop runs. We then assert the pipeline:
//   - applied caps + counts,
//   - dispatched in dependency order and injected the upstream result as context,
//   - verified each result and looped fix exactly once on the failing one,
//   - returned the synthesized `final`.
// Prints "HARNESS_OK" on success; exits 1 with a reason on any failed check.

import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'workflows', 'team.mjs')
let src
try {
  src = fs.readFileSync(file, 'utf8')
} catch (e) {
  console.error('HARNESS_BAD cannot read team.mjs: ' + e.message)
  process.exit(1)
}

// `export const meta` -> `const meta` so the body is legal inside a function (not a module).
const body = src.replace(/^\s*export\s+const\s+meta/m, 'const meta')

// ---- stubs ------------------------------------------------------------------
const calls = { dispatch: [], verify: [], phases: [] }
let sawUpstreamContext = false
let sawCodexVerify = false // verify stage delegates to codex by default
const verifyCount = {} // label -> times verified

async function agentStub(prompt, opts = {}) {
  const label = String(opts.label || '')
  const schema = opts.schema || null
  const props = (schema && schema.properties) || {}

  // Decompose: schema has a `subtasks` array.
  if (props.subtasks || label === 'decompose') {
    return {
      subtasks: [
        { label: 'model', task: 'design the data model', backend: 'native', tier: 'sonnet', deps: [], verify: 'schema present' },
        { label: 'sql', task: 'write the SQL report', backend: 'agy', tier: 'standard', deps: ['model'], verify: 'valid SQL' },
      ],
    }
  }

  // Verify: schema has a `pass` boolean. Fail `sql` exactly once to exercise the fix loop.
  if (props.pass || label.startsWith('verify:')) {
    const m = label.match(/^verify:(.+)$/)
    const who = m ? m[1] : 'unknown'
    verifyCount[who] = (verifyCount[who] || 0) + 1
    calls.verify.push(who)
    // Default verifier delegates the review to codex (run.sh forced codex decision).
    if (/team-verify|backend":"codex|codex \(OpenAI/i.test(prompt)) sawCodexVerify = true
    if (who === 'sql' && verifyCount[who] === 1) {
      return { pass: false, reason: 'missing GROUP BY', fix_hint: 'add a GROUP BY clause' }
    }
    return { pass: true, reason: 'looks correct', fix_hint: '' }
  }

  // Dispatch / fix: label is `agy:<x>` / `native:<x>` (possibly `<x>#fixN`).
  calls.dispatch.push(label)
  if (label.startsWith('native:model')) return 'MODEL_RESULT_AABBCC'
  if (label.startsWith('agy:sql')) {
    if (prompt.includes('MODEL_RESULT_AABBCC')) sawUpstreamContext = true
    return 'SQL_RESULT_DDEEFF'
  }
  if (label === 'synthesize') return 'FINAL_SYNTHESIS'
  return 'GENERIC_RESULT'
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
  caps: { gemini: 4, claude: 2 },
  pluginRoot: '/fake/plugin/root',
  verify: true,
  maxFixLoops: 1,
}

// ---- run --------------------------------------------------------------------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let out
try {
  const fn = new AsyncFunction(
    'args',
    'helpers',
    `const { agent, parallel, pipeline, phase, log } = helpers;\n${body}`
  )
  out = await fn(stubArgs, {
    agent: agentStub,
    parallel: parallelStub,
    pipeline: pipelineStub,
    phase: phaseStub,
    log: logStub,
  })
} catch (e) {
  console.error('HARNESS_BAD execution threw: ' + (e && e.stack ? e.stack : e))
  process.exit(1)
}

// ---- assert -----------------------------------------------------------------
const fails = []
const ck = (cond, msg) => { if (!cond) fails.push(msg) }

ck(out && typeof out === 'object', 'no result object returned')
ck(!out.error, 'unexpected error: ' + (out && out.error))
ck(out.counts && out.counts.agy === 1, 'expected counts.agy=1, got ' + JSON.stringify(out.counts))
ck(out.counts && out.counts.native === 1, 'expected counts.native=1')
ck(out.counts && out.counts.verified === 2, 'expected counts.verified=2, got ' + (out.counts && out.counts.verified))
ck(out.counts && out.counts.failed === 0, 'expected counts.failed=0, got ' + (out.counts && out.counts.failed))
ck(out.final === 'FINAL_SYNTHESIS', 'expected synthesized final, got ' + out.final)

const sql = (out.results || []).find((r) => r.label === 'sql')
const model = (out.results || []).find((r) => r.label === 'model')
ck(!!model, 'no model record')
ck(!!sql, 'no sql record')
ck(sql && sql.attempts === 2, 'expected sql attempts=2 (one fix), got ' + (sql && sql.attempts))
ck(sql && sql.status === 'verified', 'expected sql status=verified, got ' + (sql && sql.status))
ck(sawUpstreamContext, 'dependency context NOT injected into dependent subtask (sql never saw model result)')
ck(sawCodexVerify, 'verify stage did NOT delegate to codex by default (no codex relay in the verify prompt)')

// model must be dispatched before sql (dependency ordering / waves).
const iModel = calls.dispatch.findIndex((l) => l.startsWith('native:model'))
const iSql = calls.dispatch.findIndex((l) => l.startsWith('agy:sql'))
ck(iModel >= 0 && iSql >= 0 && iModel < iSql, 'model not dispatched before sql (wave ordering broken)')

// the fix re-dispatch must have happened (a label carrying #fix).
ck(calls.dispatch.some((l) => l.includes('#fix')), 'no fix re-dispatch observed')

if (fails.length) {
  console.error('HARNESS_BAD\n - ' + fails.join('\n - '))
  process.exit(1)
}
console.log('HARNESS_OK agy=1 native=1 verified=2 fixLoop=1 depCtx=ok codexVerify=ok')
