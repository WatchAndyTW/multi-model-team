/**
 * team-plan.mjs — expand a /team plan.json into per-subtask files + a manifest.
 * Node ESM port of scripts/lib/team_plan.py. Zero runtime dependencies.
 *
 * Exports:
 *   planToManifest(plan, workdir)
 *     plan    — array of { label, task, backend, tier, deps?, verify? }
 *     workdir — directory to write <idx>.task files into (created if absent)
 *     returns — string[] of TSV rows: "BE\tidx\tlabel\ttier\tpath"
 *
 * Backend normalisation: agy/gemini/flash/pro/google -> AGY
 *                        codex/chatgpt/openai/gpt    -> CODEX
 *                        claude/native/sonnet/opus/anthropic -> NATIVE
 *                        unknown                     -> NATIVE  (safe default)
 * Tier allowlist + TSV-injection hardening: only whitelisted values reach the manifest;
 * embedded \t / \n in a crafted tier string are neutralised before any comparison.
 * Label sanitised to [A-Za-z0-9._-] ≤48 chars.
 * Empty-task entries are skipped (noted to stderr).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join }                     from 'node:path';

// ─── constants ───────────────────────────────────────────────────────────────

const AGY    = new Set(['agy', 'gemini', 'flash', 'pro', 'google']);
const CODEX  = new Set(['codex', 'chatgpt', 'openai', 'gpt']);
const NATIVE = new Set(['native', 'claude', 'sonnet', 'opus', 'anthropic']);

const CLI_TIERS    = new Set(['cheap', 'standard']);
const NATIVE_TIERS = new Set(['sonnet', 'opus']);

// ─── helpers ─────────────────────────────────────────────────────────────────

function _normalizeBackend(name) {
  const lc = String(name ?? '').trim().toLowerCase();
  if (AGY.has(lc))    return 'AGY';
  if (CODEX.has(lc))  return 'CODEX';
  if (NATIVE.has(lc)) return 'NATIVE';
  return '';  // unknown
}

/**
 * Allowlist the tier per backend.  Also the TSV-injection boundary:
 * strip \t and \n BEFORE comparison so a crafted tier can't forge a new row.
 */
function _normalizeTier(raw, backend) {
  const t = String(raw ?? '').replace(/[\t\n\r]/g, '').trim().toLowerCase();
  if (backend === 'NATIVE') return NATIVE_TIERS.has(t) ? t : 'sonnet';
  return CLI_TIERS.has(t) ? t : 'standard';
}

function _sanitizeLabel(label, idx) {
  const clean = String(label ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean.slice(0, 48)) || `task${idx}`;
}

// ─── planToManifest ──────────────────────────────────────────────────────────

/**
 * Write per-subtask .task files and return TSV manifest rows.
 *
 * @param {object[]} plan     Array of subtask objects from plan.json
 * @param {string}   workdir  Directory for .task files (created if absent)
 * @returns {string[]}        TSV rows: "BE\tidx\tlabel\ttier\tpath"
 */
export function planToManifest(plan, workdir) {
  if (!Array.isArray(plan)) {
    throw new TypeError('planToManifest: plan must be an array');
  }

  mkdirSync(workdir, { recursive: true });

  const rows = [];

  for (let idx = 0; idx < plan.length; idx++) {
    const item = plan[idx];

    if (!item || typeof item !== 'object') {
      process.stderr.write(`team_plan: skip non-object entry #${idx}\n`);
      continue;
    }

    const taskText = item.task != null ? String(item.task) : '';
    if (!taskText.trim()) {
      process.stderr.write(`team_plan: skip entry #${idx} with empty task\n`);
      continue;
    }

    let backend = _normalizeBackend(item.backend ?? 'native');
    if (!backend) backend = 'NATIVE';  // unknown -> safe default

    const tier  = _normalizeTier(item.tier, backend);
    const label = _sanitizeLabel(item.label, idx);

    // Write raw task text, LF line endings, no shell processing.
    const taskPath = join(workdir, `${idx}.task`);
    writeFileSync(taskPath, taskText.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), { encoding: 'utf8' });

    rows.push(`${backend}\t${idx}\t${label}\t${tier}\t${taskPath}`);
  }

  return rows;
}
