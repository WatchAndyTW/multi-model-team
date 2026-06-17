#!/usr/bin/env node
/**
 * reason.mjs — scripted panel fan-out for /reasoning (Node ESM, sibling of team.mjs).
 *
 * The Fusion PANEL stage as a no-agents script: fan the SAME question out to a panel of
 * (backend, tier) panelists. CLI panelists (agy/codex) run in PARALLEL via src/bin/run.mjs
 * subprocesses (each fed the question on stdin, forced --decision rule "reason"); native
 * panelists are LISTED for in-context answering (this script can't run Claude as a subprocess —
 * true per-model native parallelism is the workflow's job).
 *
 * Usage:
 *   node reason.mjs --panel '<json Panelist[]>' [--cap N]        # question on stdin (preferred)
 *   node reason.mjs --panel-spec '2:gemini,codex' [--cap N]      # parsed via reason-spec + roster default
 *
 * Panelist = { backend: 'native'|'agy'|'codex', tier: string, label: string, token?: string }
 *
 * Injection-safe: the question text never touches a shell argument — it rides on each child's
 * stdin (spawned with stdio pipe), never argv. Parity with team.mjs output format
 * (===MMT-REASON … === blocks, --- PANELIST BE [label] (be/tier) --- headers).
 *
 * Zero runtime dependencies (Node stdlib only). ESM, win32/linux/darwin.
 */

import { spawn }                    from 'node:child_process';
import { dirname, resolve }         from 'node:path';
import { fileURLToPath }            from 'node:url';
import { resolveRosterPath }        from '../lib/platform.mjs';

// ─── locate self ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const RUN_MJS    = resolve(__dirname, 'run.mjs');

// ─── CLI args ──────────────────────────────────────────────────────────────────

function usage(err) {
  if (err) process.stderr.write(`reason.mjs: ${err}\n`);
  process.stderr.write(
    'Usage: node reason.mjs --panel <json Panelist[]> [--cap N]      (question on stdin)\n' +
    '       node reason.mjs --panel-spec <tokens> [--cap N]          (parsed via reason-spec)\n' +
    '  --panel <json>      resolved Panelist[] JSON: [{backend,tier,label}] (preferred)\n' +
    '  --panel-spec <str>  comma token spec ("2:gemini,opus,codex"); uses roster reasoning.panel default\n' +
    '  --cap N             max parallel CLI processes (default = roster reasoning.cap, ceiling 16)\n' +
    '  --help              print this help\n' +
    '\n' +
    'The QUESTION is read from stdin (injection-safe). CLI panelists (agy/codex) run in parallel\n' +
    'via run.mjs; native panelists are listed for in-context answering.\n'
  );
  process.exit(err ? 2 : 0);
}

const argv = process.argv.slice(2);
let panelJson = '';
let panelSpec = '';
let cap = 0;            // 0 = unset; resolved below from roster default

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') usage(null);
  if (a === '--panel')            { panelJson = argv[++i] ?? ''; continue; }
  if (a.startsWith('--panel='))   { panelJson = a.slice('--panel='.length); continue; }
  if (a === '--panel-spec')       { panelSpec = argv[++i] ?? ''; continue; }
  if (a.startsWith('--panel-spec=')) { panelSpec = a.slice('--panel-spec='.length); continue; }
  if (a === '--cap')              { cap = parseInt(argv[++i] ?? '', 10); continue; }
  if (a.startsWith('--cap='))     { cap = parseInt(a.slice('--cap='.length), 10); continue; }
  usage(`unknown argument: ${a}`);
}

// ─── read the question from stdin (injection-safe) ───────────────────────────

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ─── resolve the panel ────────────────────────────────────────────────────────

// Coerce a raw panelist object into a sane { backend, tier, label }. Unknown backends -> native.
function coercePanelist(p, i) {
  const o = (p && typeof p === 'object') ? p : {};
  let backend = String(o.backend || '').toLowerCase();
  if (backend !== 'agy' && backend !== 'codex' && backend !== 'native') backend = 'native';
  const tier = String(o.tier || (backend === 'native' ? 'sonnet' : 'standard')) || 'sonnet';
  const label = String(o.label || o.token || `${backend}-${i + 1}`)
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `${backend}-${i + 1}`;
  return { backend, tier, label, token: o.token != null ? String(o.token) : label };
}

async function resolvePanel() {
  // Default cap ceiling. The roster reasoning.cap default (6) is used when neither --cap nor a
  // roster value is available; the hard ceiling is 16 (parity with team.mjs).
  let rosterDefaultPanel = ['opus', 'sonnet', 'gemini'];
  let rosterCap = 6;

  // --panel (preferred): a resolved Panelist[] JSON. Fail-closed on bad JSON.
  if (panelJson) {
    let parsed;
    try {
      parsed = JSON.parse(panelJson);
    } catch (e) {
      process.stderr.write(`reason.mjs: invalid --panel JSON: ${e.message}\n`);
      process.exit(2);
    }
    if (!Array.isArray(parsed)) {
      process.stderr.write('reason.mjs: --panel must be a JSON array of panelists\n');
      process.exit(2);
    }
    const panel = parsed.map(coercePanelist);
    return { panel, capDefault: rosterCap };
  }

  // --panel-spec (convenience): parse via reason-spec using the roster reasoning default. config +
  // reason-spec are imported lazily here so the primary --panel path / --help never depend on them.
  if (panelSpec) {
    const cfg = await loadReasoningConfig();
    if (cfg) {
      if (Array.isArray(cfg.panel) && cfg.panel.length) rosterDefaultPanel = cfg.panel;
      if (Number.isFinite(cfg.cap)) rosterCap = cfg.cap;
    }
    const specMod = await import('../lib/reason-spec.mjs');
    const parsed = specMod.parsePanel(panelSpec, { defaultPanel: rosterDefaultPanel, cap: cap > 0 ? cap : rosterCap });
    const panel = (parsed && Array.isArray(parsed.panel) ? parsed.panel : []).map(coercePanelist);
    return { panel, capDefault: rosterCap };
  }

  // Neither flag: expand the roster default panel tokens via reason-spec.
  const cfg = await loadReasoningConfig();
  if (cfg) {
    if (Array.isArray(cfg.panel) && cfg.panel.length) rosterDefaultPanel = cfg.panel;
    if (Number.isFinite(cfg.cap)) rosterCap = cfg.cap;
  }
  const specMod = await import('../lib/reason-spec.mjs');
  const parsed = specMod.parsePanel('', { defaultPanel: rosterDefaultPanel, cap: cap > 0 ? cap : rosterCap });
  const panel = (parsed && Array.isArray(parsed.panel) ? parsed.panel : []).map(coercePanelist);
  return { panel, capDefault: rosterCap };
}

// Load the roster reasoning config (default panel + cap) for the convenience paths.
async function loadReasoningConfig() {
  const cfgMod = await import('../lib/config.mjs');
  // Shared resolver: $MMT_ROSTER > ~/.claude/mmt-roster.json (if present) > plugin default.
  const rosterPath = resolveRosterPath(resolve(__dirname, '..', '..'));
  const roster = cfgMod.loadRoster(rosterPath);
  return cfgMod.reasoningConfig(roster);
}

// ─── dispatch one CLI panelist via run.mjs ───────────────────────────────────

/**
 * Run a single CLI panelist. Feeds the question on stdin to `node run.mjs --decision …`.
 * Returns { label, backend, tier, stdout, stderr, code }.
 */
function runPanelist({ backend, tier, label }, question) {
  return new Promise((resolveP) => {
    const decision = JSON.stringify({
      backend,
      model: '',
      tier,
      rule: 'reason',
      native: false,
    });

    const child = spawn(
      process.execPath,
      [RUN_MJS, '--decision', decision],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', d => outChunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));

    // Feed the SAME question to this child on stdin, then close it.
    child.stdin.on('error', () => {});
    child.stdin.write(question);
    child.stdin.end();

    child.on('close', (code) => {
      resolveP({
        label,
        backend,
        tier,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code: code ?? 1,
      });
    });
    child.on('error', () => {
      resolveP({ label, backend, tier, stdout: '', stderr: 'spawn failed', code: 1 });
    });
  });
}

// ─── parallel dispatch with concurrency cap (semaphore pool) ──────────────────

/**
 * Run tasks in parallel, up to `n` at a time. Returns results in input order.
 */
async function runParallel(tasks, n) {
  if (tasks.length === 0) return [];
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const pool = Array.from({ length: Math.min(n, tasks.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

// Last non-winpty stderr line (parity with team.mjs err_tail).
function errTail(text) {
  const lines = String(text || '').split('\n').filter(l => l && !l.includes('winpty.cc'));
  return lines[lines.length - 1] ?? '';
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const question = (await readStdin()).trim();
  if (!question) {
    process.stderr.write('reason.mjs: no question text on stdin\n');
    process.exit(2);
  }

  const { panel, capDefault } = await resolvePanel();

  // Resolve the concurrency cap: --cap > roster reasoning.cap default; ceiling 16, floor 1.
  let useCap = cap > 0 ? cap : (Number.isFinite(capDefault) && capDefault > 0 ? capDefault : 6);
  if (!Number.isFinite(useCap) || useCap < 1) useCap = 1;
  if (useCap > 16) useCap = 16;

  // Partition: CLI (agy/codex) vs native.
  const cliPanelists    = panel.filter(p => p.backend === 'agy' || p.backend === 'codex');
  const nativePanelists = panel.filter(p => p.backend === 'native');

  // Run every CLI panelist in parallel (same question to each).
  const cliResults = await runParallel(
    cliPanelists.map(p => () => runPanelist(p, question)),
    useCap
  );

  // ─── emit the ===MMT-REASON block ─────────────────────────────────────────
  const out = process.stdout;
  out.write(`===MMT-REASON panel: ${cliPanelists.length} cli (cap=${useCap}), ${nativePanelists.length} native ===\n`);

  for (const r of cliResults) {
    const { label, backend, tier, stdout, stderr } = r;
    const firstLine = stdout.split('\n')[0] ?? '';
    if (stdout.length > 0 && firstLine.startsWith('MMT_NATIVE_HANDOFF')) {
      out.write(`\n--- PANELIST ${backend.toUpperCase()} [${label}] (${backend}/${tier}) -> NATIVE HANDOFF (${backend} unavailable; answer in-context) ---\n`);
      out.write(stdout);
    } else {
      out.write(`\n--- PANELIST ${backend.toUpperCase()} [${label}] (${backend}/${tier}) ---\n`);
      if (stdout.length > 0) {
        out.write(stdout);
      } else {
        const tail = errTail(stderr);
        if (tail) out.write(`[stderr] ${tail}\n`);
      }
    }
  }

  // Native panelists: listed for in-context answering (the script can't run Claude as a subprocess).
  for (const p of nativePanelists) {
    out.write(`\n--- PANELIST native [${p.label}] (native/${p.tier}) — answer in-context ---\n`);
    out.write(question);
    if (!question.endsWith('\n')) out.write('\n');
  }

  out.write('\n===MMT-REASON end ===\n');
}

main().catch((e) => {
  process.stderr.write(`reason.mjs: fatal: ${String(e && e.stack || e)}\n`);
  process.exit(1);
});
