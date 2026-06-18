#!/usr/bin/env node
/**
 * route.mjs — CLI entry point (replaces route.sh).
 * Reads task from stdin or args; flags: --preset, --explain, --tags, --roster.
 * Prints decision JSON to stdout. Exits non-zero on no-task.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readFileSync } from 'fs';
import { decide } from '../lib/router.mjs';
import { validateRoster } from '../lib/validate-config.mjs';
import { knownTypes } from '../lib/score.mjs';
import { resolveRosterPath } from '../lib/platform.mjs';

// Resolve project root from this file's location (src/bin/route.mjs -> root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const MMT_ROOT = resolve(__dirname, '..', '..');

// --- arg parsing ---
const args = process.argv.slice(2);
let preset = '';
let explain = false;
let validate = false;
let tagsPath = process.env.MMT_TAGS || join(MMT_ROOT, 'config', 'tags.txt');
// Default via shared resolver: .mmt/roster.json (cwd) > ~/.claude/mmt-roster.json > plugin default.
// An explicit --roster flag (below) still overrides this.
let rosterPath = resolveRosterPath(MMT_ROOT);
let taskParts = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--preset' && i + 1 < args.length) { preset = args[++i]; }
  else if (a.startsWith('--preset=')) { preset = a.slice('--preset='.length); }
  else if (a === '--explain') { explain = true; }
  else if (a === '--validate') { validate = true; }
  else if (a === '--tags' && i + 1 < args.length) { tagsPath = args[++i]; }
  else if (a.startsWith('--tags=')) { tagsPath = a.slice('--tags='.length); }
  else if (a === '--roster' && i + 1 < args.length) { rosterPath = args[++i]; }
  else if (a.startsWith('--roster=')) { rosterPath = a.slice('--roster='.length); }
  else if (a === '--') { taskParts = args.slice(i + 1); break; }
  else if (a.startsWith('-')) { process.stderr.write(`route.mjs: unknown flag: ${a}\n`); process.exit(2); }
  else { taskParts = args.slice(i); break; }
}

async function readStdin() {
  return new Promise((res) => {
    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    process.stdin.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => res(''));
  });
}

async function main() {
  let task = taskParts.join(' ');

  // Fall back to stdin if no positional task given and stdin is not a TTY.
  if (!task && !process.stdin.isTTY) {
    task = (await readStdin()).replace(/\r?\n$/, '');
  }

  // Load roster.
  let roster;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`route.mjs: could not load roster: ${e.message}\n`);
    process.exit(1);
  }

  // --validate mode: check roster schema and exit. Pass the tags.txt type labels so the validator
  // can flag any route that references a type not defined there.
  if (validate) {
    let known;
    try { known = knownTypes(tagsPath); } catch { known = undefined; }
    const result = validateRoster(roster, known);
    result.errors.forEach(err => process.stderr.write(`error: ${err}\n`));
    result.warnings.forEach(warn => process.stderr.write(`warning: ${warn}\n`));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  }

  if (!task) {
    process.stderr.write('route.mjs: no task text (pass as arg or stdin)\n');
    process.exit(2);
  }

  let decision;
  try {
    decision = decide({ task, roster, tagsPath, preset: preset || undefined });
  } catch (e) {
    process.stderr.write(`route.mjs: internal error: ${e.message}\n`);
    const fallback = {
      backend: 'native', model: 'native:sonnet', tier: 'sonnet',
      rule: 'internal-error', native: true,
      preset: preset || 'balanced',
      score: { chars: [...task].length, types: [] },
      nearMisses: [],
      confidence: 'low'
    };
    process.stdout.write(JSON.stringify(fallback) + '\n');
    process.exit(0);
  }

  if (explain) {
    const nearMissLines = decision.nearMisses.length === 0
      ? ['<none>']
      : decision.nearMisses.map(nm => `${nm.rule.name} (${nm.backend}/${nm.tier})`);
    process.stderr.write([
      '── route.mjs decision ─────────────────────────────',
      `task chars    : ${decision.score.chars}`,
      `task types    : ${decision.score.types.join(', ') || '<none>'}`,
      `preset        : ${decision.preset}`,
      `confidence    : ${decision.confidence}`,
      `near misses   : ${nearMissLines.join(', ')}`,
      `roster        : ${rosterPath}`,
      `decision      : ${JSON.stringify(decision)}`,
      '───────────────────────────────────────────────────',
    ].join('\n') + '\n');
  }

  process.stdout.write(JSON.stringify(decision) + '\n');
}

main();
