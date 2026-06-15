#!/usr/bin/env node
// run.mjs — execute a delegation: route -> fallback chain -> backend -> clean output.
//
// Writes HUD state on each hop start/end. On exhaustion (or a native decision) prints a
// native-handoff sentinel so the caller (delegate agent / Opus) solves it in-context.
//
// Parity target: scripts/run.sh (fallback chain + handoff). ESM, Node stdlib only.
//
// Usage:
//   node run.mjs [--preset P] [--tags PATH] [--roster PATH] [--sandbox] [--decision JSON] "<task text>"
//   echo "<task text>" | node run.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoster, defaults, backend } from '../lib/config.mjs';
import { decide } from '../lib/router.mjs';
import { invoke, health, clean } from '../lib/backends.mjs';
import * as state from '../lib/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MMT_ROOT = path.resolve(__dirname, '..', '..');

const COMPACT_CONTRACT = 'Return only the result, no preamble.';
const COMPACT_PROMPT = (task) => `${COMPACT_CONTRACT}\n\n${task}`;

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const o = { preset: '', tags: '', roster: '', decision: '', sandbox: false, task: '' };
  let i = 0;
  const positional = [];
  while (i < argv.length) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > -1 ? a.slice(0, eq) : a;
    const inlineVal = a.startsWith('--') && eq > -1 ? a.slice(eq + 1) : null;
    const next = () => (inlineVal !== null ? inlineVal : argv[++i]);
    switch (flag) {
      case '--preset':   o.preset = next() ?? ''; break;
      case '--tags':     o.tags = next() ?? ''; break;
      case '--roster':   o.roster = next() ?? ''; break;
      case '--decision': o.decision = next() ?? ''; break;
      case '--sandbox':  o.sandbox = true; break;
      case '--':         positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-')) { process.stderr.write(`run.mjs: unknown flag: ${a}\n`); process.exit(2); }
        positional.push(...argv.slice(i)); i = argv.length; break;
    }
    i++;
  }
  if (positional.length) o.task = positional.join(' ');
  return o;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Code-point count (parity with `wc -m`).
function charCount(s) {
  return [...String(s)].length;
}

// Sanitize a backend's stderr into a short, single-line reason (parity with run.sh):
//   newlines -> spaces, " -> ', tail-truncate to 240 (prefixed with ... when longer).
function sanitizeErr(err) {
  let v = String(err || '').replace(/\n/g, ' ').replace(/"/g, "'");
  if (v.length > 240) v = '...' + v.slice(-240);
  return v;
}

function nativeSentinel(tier, rule, reason) {
  process.stdout.write(`MMT_NATIVE_HANDOFF tier=${tier} rule=${rule} reason="${reason}"\n`);
  process.stdout.write(
    'This task was routed to native Claude (no agy offload). Solve it directly in-context at the indicated tier.\n',
  );
}

// Resolve tier -> concrete model from a backend cfg's model_tiers.
function modelForTier(beCfg, tier) {
  const tiers = beCfg.model_tiers || {};
  // 'cheap'/'standard' are the canonical keys; a tier label maps to standard unless it's the cheap one.
  const m = tiers[tier] || tiers.standard || tiers.cheap || '';
  return m;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let task = opts.task;
  if (!task) task = (await readStdin()).trim();
  if (!task) { process.stderr.write('run.mjs: no task text\n'); process.exit(2); }

  const rosterPath =
    opts.roster || process.env.MMT_ROSTER || path.join(MMT_ROOT, 'config', 'roster.json');
  const tagsPath = opts.tags || path.join(MMT_ROOT, 'config', 'tags.txt');

  let roster;
  try {
    roster = loadRoster(rosterPath);
  } catch (e) {
    // Fail closed to native if the roster is unreadable.
    nativeSentinel('sonnet', 'no-roster', `roster load failed: ${sanitizeErr(e && e.message)}`);
    process.exit(0);
  }

  // ---- 1. Decision -----------------------------------------------------------
  // Safe native defaults survive any decision failure (fail closed — never fall open to agy).
  let decision = { backend: 'native', model: 'native:sonnet', tier: 'sonnet', rule: 'catch-all-safe', native: true };
  if (opts.decision) {
    try {
      const d = JSON.parse(opts.decision);
      decision = {
        backend: d.backend || 'native',
        model: d.model || 'native:sonnet',
        tier: d.tier || 'sonnet',
        rule: d.rule || 'catch-all-safe',
        native: !!d.native,
      };
    } catch {
      // bad forced decision JSON -> keep safe native defaults (fail closed).
    }
  } else {
    try {
      const d = decide({ task, roster, tagsPath, preset: opts.preset || undefined });
      if (d && d.backend) decision = d;
    } catch {
      // router error -> safe native defaults survive.
    }
  }
  // Belt-and-suspenders: an empty backend must never fail open to agy.
  if (!decision.backend) { decision.backend = 'native'; decision.native = true; }

  const D_tier = decision.tier || 'sonnet';
  const D_rule = decision.rule || 'catch-all-safe';

  // ---- 2. Native decision -> immediate handoff -------------------------------
  if (decision.native || decision.backend === 'native' || String(decision.backend).startsWith('native:')) {
    nativeSentinel(D_tier, D_rule, 'router selected native backend');
    process.exit(0);
  }

  // ---- 3. Build fallback chain: chosen backend + quota_fallback (deduped) -----
  const dfl = (() => { try { return defaults(roster) || {}; } catch { return {}; } })();
  const quotaFallback = Array.isArray(dfl.quota_fallback) ? dfl.quota_fallback : [];
  const defaultFallback = dfl.fallback || 'native:sonnet';

  const chain = [decision.backend];
  for (const e of quotaFallback) if (!chain.includes(e)) chain.push(e);

  const fullPrompt = COMPACT_PROMPT(task);
  const inChars = charCount(task);
  const callId = String(Math.floor(Math.random() * 1e6)).padStart(6, '0').slice(0, 6);

  // ---- 4. Walk the chain -----------------------------------------------------
  let lastErr = ''; // short, sanitized reason from the last backend that actually failed
  let fallbackCount = 0;

  for (const entry of chain) {
    if (entry === 'native' || String(entry).startsWith('native:')) {
      let tier = entry === 'native' ? '' : String(entry).slice('native:'.length);
      tier = tier || D_tier;
      const reason = `backend options exhausted; falling back to native${lastErr ? ` (last error: ${lastErr})` : ''}`;
      nativeSentinel(tier, D_rule, reason);
      process.exit(0);
    }

    const be = entry;
    let beCfg;
    try {
      beCfg = backend(roster, be);
    } catch {
      process.stderr.write(`run.mjs: cannot load backend '${be}' (skipped)\n`);
      fallbackCount++; continue;
    }
    if (!beCfg || !beCfg.enabled) {
      process.stderr.write(`run.mjs: backend '${be}' disabled or unknown (skipped)\n`);
      fallbackCount++; continue;
    }

    // Optional --sandbox: append the backend's sandbox flag for this hop only. Skipped when the
    // backend defines no single-flag sandbox (e.g. codex, already `-s read-only`).
    let invokeCfg = beCfg;
    if (opts.sandbox && beCfg.sandbox_flag) {
      invokeCfg = { ...beCfg, extra: [...(beCfg.extra || []), beCfg.sandbox_flag] };
    }

    let model = modelForTier(beCfg, D_tier) || modelForTier(beCfg, 'standard');

    // Health-gate: an unhealthy backend (or a kind with no invoker) is skipped.
    let healthy = false;
    try { healthy = await health(beCfg); } catch { healthy = false; }
    if (!healthy) { fallbackCount++; continue; }

    state.start({ id: callId, backend: be, model, rule: D_rule, inChars });
    const startMs = Date.now();
    let res;
    try {
      res = await invoke(invokeCfg, fullPrompt, { model, tier: D_tier });
    } catch (e) {
      res = { ok: false, stdout: '', stderr: String(e && e.message || e), code: 1, quota: false };
    }
    const durMs = Date.now() - startMs;
    const cleanOut = clean(res.stdout || '');
    const outChars = charCount(cleanOut);

    // quota/credit exhaustion -> next hop.
    if (res.quota) {
      lastErr = `quota/credit limit on '${be}'`;
      process.stderr.write(`run.mjs: backend '${be}' hit a quota/credit limit — falling back\n`);
      state.end({ id: callId, backend: be, model, rule: D_rule, code: res.code, durMs, outChars, fallback: 1 });
      fallbackCount++; continue;
    }

    // non-zero exit OR empty clean output -> surface + sanitize stderr, next hop.
    if (res.code !== 0 || !cleanOut) {
      lastErr = sanitizeErr(res.stderr);
      process.stderr.write(
        `run.mjs: backend '${be}' returned no usable output (exit ${res.code})${lastErr ? ` — stderr: ${lastErr}` : ''}\n`,
      );
      state.end({ id: callId, backend: be, model, rule: D_rule, code: res.code, durMs, outChars, fallback: 1 });
      fallbackCount++; continue;
    }

    // success.
    state.end({ id: callId, backend: be, model, rule: D_rule, code: 0, durMs, outChars, fallback: fallbackCount });
    process.stdout.write(cleanOut + '\n');
    process.exit(0);
  }

  // ---- 5. Everything exhausted -> guaranteed native fallback -----------------
  const tier = defaultFallback.startsWith('native:') ? defaultFallback.slice('native:'.length) : D_tier;
  const reason = `all backends exhausted${lastErr ? ` (last error: ${lastErr})` : ''}`;
  nativeSentinel(tier, D_rule, reason);
  process.exit(0);
}

main().catch((e) => {
  // Last-resort fail-closed handoff; never crash into a non-handoff state.
  process.stderr.write(`run.mjs: fatal: ${String(e && e.stack || e)}\n`);
  nativeSentinel('sonnet', 'fatal', `run.mjs fatal: ${sanitizeErr(e && e.message)}`);
  process.exit(0);
});
