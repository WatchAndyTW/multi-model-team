#!/usr/bin/env node
/**
 * team.mjs — parallel CLI-backend fan-out for /team (Node ESM port of scripts/team.sh).
 *
 * Usage:
 *   node team.mjs --plan <plan.json> [--gemini-cap N]
 *
 * Runs CLI-backend subtasks (AGY, CODEX) from plan.json in PARALLEL (bounded by --gemini-cap,
 * default 4, ceiling 16) via src/bin/run.mjs subprocesses, each fed its task via stdin with a
 * forced --decision from the manifest. Prints delimited blocks per result.
 * NATIVE subtasks are listed with a "solve in-context" note — NOT executed here.
 *
 * Injection-safe: task text never touches a shell argument. planToManifest() writes each task
 * to a temp file; run.mjs reads it via stdin (spawned with stdio pipe), never argv.
 * Parity with scripts/team.sh output format (===MMT-TEAM … === blocks, --- BE [label] --- headers).
 *
 * Zero runtime dependencies (Node stdlib only). ESM, win32/linux/darwin.
 */

import { createReadStream }              from 'node:fs';
import { readFile }                      from 'node:fs/promises';
import { tmpdir }                        from 'node:os';
import { join, dirname, resolve }        from 'node:path';
import { spawn }                         from 'node:child_process';
import { fileURLToPath }                 from 'node:url';
import { mkdtempSync, rmSync }           from 'node:fs';

import { planToManifest }  from '../lib/team-plan.mjs';

// ─── locate self ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const RUN_MJS    = resolve(__dirname, 'run.mjs');

// ─── CLI args ─────────────────────────────────────────────────────────────────

function usage(err) {
  if (err) process.stderr.write(`team.mjs: ${err}\n`);
  process.stderr.write(
    'Usage: node team.mjs --plan <plan.json> [--gemini-cap N]\n' +
    '  --plan <file>     path to plan.json (array of {label,task,backend,tier,...})\n' +
    '  --gemini-cap N    max parallel CLI processes (default 4, ceiling 16)\n'
  );
  process.exit(err ? 2 : 0);
}

const args = process.argv.slice(2);
let planFile = '';
let gcap = 4;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') usage(null);
  if (a === '--plan')       { planFile = args[++i] ?? ''; continue; }
  if (a.startsWith('--plan=')) { planFile = a.slice(7); continue; }
  if (a === '--gemini-cap') { gcap = parseInt(args[++i] ?? '', 10); continue; }
  if (a.startsWith('--gemini-cap=')) { gcap = parseInt(a.slice(13), 10); continue; }
  usage(`unknown argument: ${a}`);
}

if (!planFile) usage('--plan <file> required');
if (!Number.isFinite(gcap) || gcap < 1) gcap = 1;
if (gcap > 16) gcap = 16;

// ─── load plan ───────────────────────────────────────────────────────────────

let planRaw;
try {
  planRaw = JSON.parse(await readFile(planFile, 'utf8'));
} catch (e) {
  process.stderr.write(`team.mjs: cannot read plan: ${e.message}\n`);
  process.exit(1);
}
if (!Array.isArray(planRaw)) {
  process.stderr.write('team.mjs: plan.json must be a JSON array\n');
  process.exit(1);
}

// ─── expand plan into .task files ────────────────────────────────────────────

const workdir = mkdtempSync(join(tmpdir(), 'mmt-team-'));
process.on('exit', () => { try { rmSync(workdir, { recursive: true, force: true }); } catch {} });
process.on('SIGINT',  () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

let rows;
try {
  rows = planToManifest(planRaw, workdir);
} catch (e) {
  process.stderr.write(`team.mjs: plan parse failed: ${e.message}\n`);
  process.exit(1);
}

// ─── parse manifest rows ──────────────────────────────────────────────────────

// Each row: "BE\tidx\tlabel\ttier\tpath"
const cliTasks   = [];   // { be, idx, label, tier, taskPath }
const nativeTasks = [];  // { idx, label, tier, taskPath }

for (const row of rows) {
  const parts = row.split('\t');
  if (parts.length < 5) continue;
  const [be, idxStr, label, tier, taskPath] = parts;
  const idx = parseInt(idxStr, 10);
  if (!Number.isFinite(idx)) continue;
  if (be === 'NATIVE') {
    nativeTasks.push({ idx, label, tier, taskPath });
  } else if (be === 'AGY' || be === 'CODEX') {
    cliTasks.push({ be, idx, label, tier, taskPath });
  }
  // unknown token -> skip (parity with team.sh)
}

// ─── dispatch one CLI subtask via run.mjs ────────────────────────────────────

/**
 * Run a single CLI subtask. Feeds the task file on stdin to `node run.mjs --decision …`.
 * Returns { label, be, tier, stdout, stderr, code }.
 */
function runSubtask({ be, idx, label, tier, taskPath }) {
  return new Promise((resolveP) => {
    const beLower = be.toLowerCase();
    const decision = JSON.stringify({
      backend: beLower,
      model: '',
      tier,
      rule: 'team',
      native: false,
    });

    const child = spawn(
      process.execPath,
      [RUN_MJS, '--decision', decision],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Feed task file to child's stdin, then close it.
    const taskStream = createReadStream(taskPath);
    taskStream.pipe(child.stdin);
    taskStream.on('error', () => child.stdin.destroy());

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', d => outChunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));

    child.on('error', (err) => {
      resolveP({
        label,
        be,
        tier,
        stdout: '',
        stderr: `spawn failed: ${err.message}`,
        code: 1,
      });
    });

    child.on('close', (code) => {
      resolveP({
        label,
        be,
        tier,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code: code ?? 1,
      });
    });
  });
}

// ─── parallel dispatch with concurrency cap ───────────────────────────────────

/**
 * Run tasks in parallel, up to `cap` at a time (semaphore pool).
 * Returns results in input order.
 */
async function runParallel(tasks, cap) {
  if (tasks.length === 0) return [];

  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await runSubtask(tasks[i]);
    }
  }

  const pool = Array.from({ length: Math.min(cap, tasks.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

const cliResults = await runParallel(cliTasks, gcap);

// ─── last non-winpty stderr line (parity with team.sh err_tail) ──────────────

function errTail(text) {
  const lines = text.split('\n').filter(l => l && !l.includes('winpty.cc'));
  return lines[lines.length - 1] ?? '';
}

// ─── emit results ─────────────────────────────────────────────────────────────

const out = process.stdout;

out.write(`===MMT-TEAM dispatch: ${cliTasks.length} cli (cap=${gcap}), ${nativeTasks.length} native ===\n`);

for (const r of cliResults) {
  const { label, be, tier, stdout, stderr } = r;
  const firstLine = stdout.split('\n')[0] ?? '';
  if (stdout.length > 0 && firstLine.startsWith('MMT_NATIVE_HANDOFF')) {
    out.write(`\n--- ${be} [${label}] (tier=${tier}) -> NATIVE HANDOFF (${be.toLowerCase()} unavailable; solve in-context) ---\n`);
    out.write(stdout);
  } else {
    out.write(`\n--- ${be} [${label}] (tier=${tier}) ---\n`);
    if (stdout.length > 0) {
      out.write(stdout);
    } else {
      const tail = errTail(stderr);
      if (tail) out.write(`[stderr] ${tail}\n`);
    }
  }
}

// Native subtasks: list with solve-in-context note (read task file content).
for (const t of nativeTasks) {
  out.write(`\n--- NATIVE [${t.label}] (tier=${t.tier}) — solve in-context ---\n`);
  try {
    const taskText = await readFile(t.taskPath, 'utf8');
    out.write(taskText);
    if (!taskText.endsWith('\n')) out.write('\n');
  } catch {
    out.write(`(could not read task file: ${t.taskPath})\n`);
  }
}

out.write('\n===MMT-TEAM end ===\n');
