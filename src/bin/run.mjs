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
import { randomUUID } from 'node:crypto';

import { loadRoster, defaults, backend } from '../lib/config.mjs';
import { decide } from '../lib/router.mjs';
import { invoke, health, clean, invalidateHealth } from '../lib/backends.mjs';
import * as state from '../lib/state.mjs';
import { resolveRosterPath } from '../lib/platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MMT_ROOT = path.resolve(__dirname, '..', '..');

const COMPACT_CONTRACT = 'Return only the result, no preamble.';
const COMPACT_PROMPT = (task) => `${COMPACT_CONTRACT}\n\n${task}`;

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const o = { preset: '', tags: '', roster: '', decision: '', decisionB64: '', taskB64: '', sandbox: false, addDir: '', task: '' };
  let i = 0;
  const positional = [];
  while (i < argv.length) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > -1 ? a.slice(0, eq) : a;
    const inlineVal = a.startsWith('--') && eq > -1 ? a.slice(eq + 1) : null;
    const next = () => (inlineVal !== null ? inlineVal : argv[++i]);
    switch (flag) {
      case '--preset':       o.preset = next() ?? ''; break;
      case '--tags':         o.tags = next() ?? ''; break;
      case '--roster':       o.roster = next() ?? ''; break;
      case '--decision':     o.decision = next() ?? ''; break;
      // base64url transports (shell-agnostic): the Workflow relay can't safely put a heredoc or a
      // single-quoted JSON arg on a command line that may run in PowerShell — both mangle. b64url is
      // [A-Za-z0-9_-] only, so the token survives verbatim in BOTH PowerShell and bash (and avoids
      // the MSYS argv path-conversion that a literal '/' in standard base64 triggers). Decoded here in
      // Node, never by a shell — so the untrusted payload never appears as parseable shell text.
      case '--decision-b64': o.decisionB64 = next() ?? ''; break;
      case '--task-b64':     o.taskB64 = next() ?? ''; break;
      case '--add-dir':      o.addDir = next() ?? ''; break;
      case '--sandbox':      o.sandbox = true; break;
      case '--':             positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-')) { process.stderr.write(`run.mjs: unknown flag: ${a}\n`); process.exit(2); }
        positional.push(...argv.slice(i)); i = argv.length; break;
    }
    i++;
  }
  if (positional.length) o.task = positional.join(' ');
  return o;
}

// Decode a base64url arg to UTF-8 (Node Buffer is guaranteed here, unlike the Workflow sandbox).
// Validates the alphabet ([A-Za-z0-9_-], optional, no '+'/'/'/'='), restores standard base64 +
// padding, then decodes. Invalid input exits 2 (a corrupt transport must fail loudly, not silently
// dispatch garbage to a backend).
function decodeB64UrlArg(v, flag) {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    process.stderr.write(`run.mjs: invalid ${flag}\n`);
    process.exit(2);
  }
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
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
  if (!task && opts.taskB64) task = decodeB64UrlArg(opts.taskB64, '--task-b64');
  if (!task) task = (await readStdin()).trim();
  if (!task) { process.stderr.write('run.mjs: no task text\n'); process.exit(2); }

  // --roster flag wins; else shared resolver: .mmt/roster.json (cwd) > ~/.claude/mmt-roster.json > plugin default.
  const rosterPath = opts.roster || resolveRosterPath(MMT_ROOT);
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
  // --decision-b64 (shell-agnostic) wins over --decision; either supplies the forced decision JSON.
  const forcedDecision = opts.decisionB64 ? decodeB64UrlArg(opts.decisionB64, '--decision-b64') : opts.decision;
  if (forcedDecision) {
    try {
      const d = JSON.parse(forcedDecision);
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
  const callId = randomUUID().replace(/-/g, '').slice(0, 8);

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
      res = await invoke(invokeCfg, fullPrompt, { model, tier: D_tier, addDir: opts.addDir });
    } catch (e) {
      res = { ok: false, stdout: '', stderr: String(e && e.message || e), code: 1, quota: false };
    }
    const durMs = Date.now() - startMs;
    const cleanOut = clean(res.stdout || '');
    const outChars = charCount(cleanOut);

    // quota/credit exhaustion -> next hop. A FAILED hop passes fallback:0 (it is not itself a
    // fallback); the single fallback tally is counted once on the success hop via fallbackCount.
    if (res.quota) {
      lastErr = `quota/credit limit on '${be}'`;
      process.stderr.write(`run.mjs: backend '${be}' hit a quota/credit limit — falling back\n`);
      state.end({ id: callId, backend: be, model, rule: D_rule, code: res.code, durMs, outChars, fallback: 0 });
      fallbackCount++; continue;
    }

    // non-zero exit OR empty clean output -> surface + sanitize stderr, next hop. Drop this backend's
    // cached health so a later call re-probes it instead of trusting a now-stale "healthy" verdict.
    if (res.code !== 0 || !cleanOut) {
      lastErr = sanitizeErr(res.stderr);
      process.stderr.write(
        `run.mjs: backend '${be}' returned no usable output (exit ${res.code})${lastErr ? ` — stderr: ${lastErr}` : ''}\n`,
      );
      invalidateHealth(beCfg);
      state.end({ id: callId, backend: be, model, rule: D_rule, code: res.code, durMs, outChars, fallback: 0 });
      fallbackCount++; continue;
    }

    // success. Approximate cost (USD micros) from the backend's per-1k-OUTPUT-char rate × outChars —
    // a rough HUD figure only (chars, not tokens), matching roster.json's "per 1000 output chars"
    // note. Missing/zero rate -> 0 cost.
    const rate = Number(beCfg.cost_per_1k_chars) || 0;
    const costMicros = Math.round(rate * (outChars / 1000) * 1e6);
    state.end({ id: callId, backend: be, model, rule: D_rule, code: 0, durMs, outChars, fallback: fallbackCount, costMicros });
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
