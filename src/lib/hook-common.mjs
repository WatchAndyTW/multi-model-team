// hook-common.mjs — shared hook runtime (NEW; the reliability core of the Node ESM port).
//
// The whole point of this module: each hook runs as ONE short-lived node process — read payload,
// gate, route IN-PROCESS, emit — with ZERO child forks. The bash hooks forked ~6–7 processes per
// invocation (cat, python×N, route.sh -> python + score.sh + match.py …) under a 10s msys timeout
// and got intermittently killed. Collapsing that to a single node proc is the fix.
//
// Kill switches preserved: MMT_PROACTIVE_DISABLE=1, MMT_HOOK_DISABLE=1. Fail-OPEN on ANY
// uncertainty (a hook that can't decide must never wrongly block a tool call). Zero runtime deps.

import fs from 'node:fs';
import path from 'node:path';
import { proactive as rosterProactive } from './config.mjs';
import { decide } from './router.mjs';
import { stateDir } from './platform.mjs';

// Bound on the stdin payload we will buffer (defensive — a hook payload is tiny; refuse a runaway).
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // ~2 MB

/**
 * Read the hook payload from stdin and JSON.parse it.
 * Bounded (~2 MB) and resilient: returns null on empty input, parse failure, oversize, or any error
 * (fail-OPEN — the caller treats null as "can't decide -> allow / no nudge").
 * @returns {Promise<object|null>}
 */
export function readPayload() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // If stdin is a TTY (no piped payload), there is nothing to read — bail immediately rather
    // than hang waiting for input that will never come.
    if (stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { stdin.removeAllListeners(); } catch { /* ignore */ }
      resolve(val);
    };

    stdin.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_PAYLOAD_BYTES) {
        // Oversize — stop reading and fail open.
        try { stdin.pause(); } catch { /* ignore */ }
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { done(null); return; }
      try {
        done(JSON.parse(raw));
      } catch {
        done(null);
      }
    });
    stdin.on('error', () => done(null));

    try { stdin.resume(); } catch { done(null); }
  });
}

/**
 * REAL proactive-config parse (no fragile substring scan — this kills the bash gate). Returns the
 * normalized proactive block; on any error returns a safe disabled default.
 * @param {object} roster
 * @returns {{enabled:boolean,max_chars:number,min_chars:number,rules:string,guard_spawns:boolean,enforce_spawns:boolean}}
 */
export function proactiveGate(roster) {
  try {
    return rosterProactive(roster);
  } catch {
    return { enabled: false, max_chars: 0, min_chars: 0, rules: '', guard_spawns: true, enforce_spawns: false };
  }
}

/**
 * Emit a hookSpecificOutput object as compact JSON on stdout (matches the bash python `separators`).
 * @param {object} obj
 */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * PreToolUse allow verdict, optionally with additionalContext (a non-blocking nudge).
 * @param {string} [ctx]  optional additionalContext text
 */
export function allow(ctx) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
  if (ctx) out.hookSpecificOutput.additionalContext = ctx;
  emit(out);
}

/**
 * PreToolUse deny verdict with a reason.
 * @param {string} reason
 */
export function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason || '',
    },
  });
}

/**
 * UserPromptSubmit additionalContext injection.
 * @param {string} ctx
 */
export function promptContext(ctx) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ctx || '',
    },
  });
}

/**
 * In-process routing decision (NO bash/route.sh fork). Wraps router.decide; on any error returns a
 * native fallback so callers fail open (a native decision never triggers a CLI nudge/deny).
 * @param {string} task
 * @param {{roster:object, tagsPath:string, preset?:string}} opts
 * @returns {object} decision { backend, model, tier, rule, native, ... }
 */
export function decideTask(task, { roster, tagsPath, preset } = {}) {
  try {
    return decide({ task: String(task ?? ''), roster, tagsPath, preset });
  } catch {
    return { backend: 'native', model: 'native:sonnet', tier: 'sonnet', rule: 'no-decision', native: true };
  }
}

/**
 * Append a one-line firing marker to stateDir()/hooks.log, but ONLY when MMT_HOOK_DEBUG=1.
 * Best-effort and silent — debug instrumentation must never affect the hook verdict.
 * @param {string} name  hook name
 * @param {object|string} [info]  small structured context (JSON-stringified)
 */
export function debugMark(name, info) {
  if (process.env.MMT_HOOK_DEBUG !== '1') return;
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${name} ${typeof info === 'string' ? info : JSON.stringify(info ?? {})}\n`;
    fs.appendFileSync(path.join(dir, 'hooks.log'), line, 'utf8');
  } catch {
    // ignore — debug only
  }
}

// ─── shared kill-switch / gating helpers ──────────────────────────────────────────────────────

/** MMT_HOOK_DISABLE=1 -> all hooks off. */
export function hookDisabled() {
  return process.env.MMT_HOOK_DISABLE === '1';
}

/** MMT_PROACTIVE_DISABLE=1 -> proactive hooks off. */
export function proactiveDisabled() {
  return process.env.MMT_PROACTIVE_DISABLE === '1';
}

/**
 * Resolve the roster path the way the bash hooks did: $MMT_ROSTER override else <root>/config/roster.json.
 * @param {string} pluginRoot
 * @returns {string}
 */
export function rosterPath(pluginRoot) {
  return process.env.MMT_ROSTER || path.join(pluginRoot, 'config', 'roster.json');
}

/**
 * Default tags.txt path (env override honored for tests).
 * @param {string} pluginRoot
 * @returns {string}
 */
export function tagsPath(pluginRoot) {
  return process.env.MMT_TAGS || path.join(pluginRoot, 'config', 'tags.txt');
}

/**
 * Plugin root from a hook file at hooks/<x>.mjs (one dir up from hooks/).
 * @param {string} hookFileUrl  import.meta.url of the calling hook
 * @returns {string}
 */
export function pluginRootFrom(hookFileUrl) {
  // hooks/<x>.mjs -> plugin root is the parent of hooks/.
  const here = path.dirname(new URL(hookFileUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return path.resolve(here, '..');
}

/**
 * Char-count window test (parity with the bash size-window gate). 0 disables a bound.
 * @param {number} chars
 * @param {number} minc
 * @param {number} maxc
 * @returns {boolean} true if WITHIN the window (allowed to proceed)
 */
export function withinWindow(chars, minc, maxc) {
  const c = Number(chars);
  if (!Number.isFinite(c)) return false;
  const lo = Number(minc) || 0;
  const hi = Number(maxc) || 0;
  if (hi > 0 && c > hi) return false;
  if (lo > 0 && c < lo) return false;
  return true;
}

/**
 * Optional rule allowlist test (CSV). Empty list = any rule passes (parity with bash).
 * @param {string} rulesCsv
 * @param {string} ruleName
 * @returns {boolean}
 */
export function ruleAllowed(rulesCsv, ruleName) {
  const csv = String(rulesCsv || '').trim();
  if (!csv) return true;
  const allow = csv.split(',').map((r) => r.replace(/\s+/g, '')).filter(Boolean);
  if (allow.length === 0) return true;
  return allow.includes(String(ruleName || ''));
}
