#!/usr/bin/env node
// spawn-route-guard.mjs — PreToolUse(Task|Agent) guard (Node ESM port of spawn-route-guard.sh).
//
// The "NOT /team" companion to the prompt nudge. When proactive.enabled AND proactive.guard_spawns
// are true, every agent-spawning Task/Agent call whose task routes to a CLI backend (agy or codex)
// is intercepted so the work actually runs on that CLI instead of a plain Claude sub-agent:
//   - enforce_spawns=false (default): NON-BLOCKING nudge (allow + additionalContext).
//   - enforce_spawns=true: DENY with the same instruction (except OMC team workers — see below).
//
// EXEMPT (untouched): our own /team workers + subagents — relay workers carry run.sh/--decision,
// native workers are tagged [mmt-team-worker], our subagents have a multi-model-team: subagent_type.
//
// OMC-AWARE: an oh-my-claudecode TEAM worker (team_name set, an oh-my-claudecode: agent, or the OMC
// worker preamble markers) is ALWAYS nudged, NEVER denied — even under enforce_spawns — so we can't
// break OMC's persistent-teammate orchestration.
//
// OFF by default. ONE node process, ZERO child forks (the bash version forked cat + python×3 +
// route.sh's own fork storm). Fail-OPEN: any uncertainty -> allow (silent). Hard override:
// MMT_PROACTIVE_DISABLE=1.

import fs from 'node:fs';
import path from 'node:path';
import {
  readPayload, allow, deny, decideTask, debugMark,
  proactiveGate, proactiveDisabled, hookDisabled,
  rosterPath, tagsPath, pluginRootFrom, withinWindow, ruleAllowed,
} from '../src/lib/hook-common.mjs';
import { loadRoster } from '../src/lib/config.mjs';
import { charCount } from '../src/lib/score.mjs';

const SKIP_MARKERS = ['run.mjs', 'run.sh', '--decision', 'MMT_NATIVE_HANDOFF', 'mmt-team-worker'];
const OMC_MARKERS = ['TEAM WORKER', 'team-lead', 'shutdown_request', 'shutdown_response', 'oh-my-claudecode'];

async function main() {
  if (proactiveDisabled() || hookDisabled()) return;

  const payload = await readPayload();
  if (!payload) return;

  const root = pluginRootFrom(import.meta.url);
  const rPath = rosterPath(root);
  if (!fs.existsSync(rPath)) return;

  let roster;
  try { roster = loadRoster(rPath); } catch { return; }

  const p = proactiveGate(roster);
  if (!p.enabled) return;
  if (!p.guard_spawns) return;

  // ── inspect the spawn ──────────────────────────────────────────────────────────────────────
  const tool = String(payload.tool_name || '');
  const ti = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};
  const sub = String(ti.subagent_type || '');
  const team = String(ti.team_name || '');
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  const desc = typeof ti.description === 'string' ? ti.description : '';
  const task = prompt.trim() ? prompt : desc;
  const blob = prompt + '\n' + desc;

  // OMC team-worker detection (nudge-never-deny).
  const isOmc =
    team.trim() !== '' ||
    sub.startsWith('oh-my-claudecode:') ||
    OMC_MARKERS.some((m) => blob.includes(m));

  // Skip conditions (parity with bash MMT_SKIP).
  if (tool !== 'Task' && tool !== 'Agent') return;
  if (sub.startsWith('multi-model-team:')) return;       // our own subagents
  if (!task.trim()) return;                              // empty task
  if (SKIP_MARKERS.some((m) => blob.includes(m))) return; // already wired to our dispatch

  // Size window (chars) — reuse the prompt-nudge bounds. 0 disables a bound.
  const chars = charCount(task);
  if (!withinWindow(chars, p.min_chars, p.max_chars)) return;

  // Route the spawned task in-process (no route.sh fork). Task text is data only — never echoed.
  const d = decideTask(task, { roster, tagsPath: tagsPath(root) });
  if (!d) return;

  // Only CLI backends. native stays a Claude agent — leave it.
  if (d.backend !== 'agy' && d.backend !== 'codex') return;

  // Optional rule allowlist (CSV). Empty = any agy/codex rule.
  if (!ruleAllowed(p.rules, d.rule)) return;

  const beDisp = d.backend === 'agy' ? 'agy (Gemini)' : d.backend === 'codex' ? 'codex (Codex)' : d.backend;
  const beAgent = d.backend === 'codex' ? 'multi-model-team:codex' : 'multi-model-team:delegate';
  const rule = d.rule || '?';
  const tier = d.tier || '?';
  const runMjs = path.join(root, 'src', 'bin', 'run.mjs');
  const how =
    `run \`node src/bin/run.mjs\` with a forced {"backend":"${d.backend}"} decision (subtask via stdin / ` +
    `a single-quoted heredoc), or spawn the \`${beAgent}\` agent`;

  // OMC team workers are NEVER hard-denied — always a nudge, even under enforce_spawns.
  const enforce = p.enforce_spawns && !isOmc;

  if (enforce) {
    debugMark('spawn-route-guard', { verdict: 'deny', backend: d.backend, rule, tier });
    deny(
      `multi-model-team: blocked — this spawned task routes to ${beDisp} [rule=${rule}, tier=${tier}] and ` +
      `[proactive].enforce_spawns is on. Re-issue it through the plugin CLI dispatch: ${how}, ` +
      `so it actually runs on ${d.backend} instead of a plain Claude agent. ` +
      `(Set [proactive].enforce_spawns=false for a non-blocking nudge.)`
    );
    return;
  }

  if (isOmc) {
    debugMark('spawn-route-guard', { verdict: 'omc-nudge', backend: d.backend, rule, tier });
    allow(
      `multi-model-team: this oh-my-claudecode TEAM worker has work that routes to ${beDisp} [rule=${rule}, ` +
      `tier=${tier}] per the multi-model-team config. To honor our routing, the worker should EXECUTE ` +
      `its assigned task by running \`node ${runMjs} "<the task text>"\` (our router then dispatches to ` +
      `${d.backend}, or native for hard work) and report THAT result back through its team protocol — ` +
      `instead of solving the task directly in Claude. It keeps following the OMC ` +
      `TaskList/SendMessage flow; only the heavy lifting moves to our CLI. Not blocking — ignore ` +
      `for work that needs in-context / codebase judgment.`
    );
    return;
  }

  debugMark('spawn-route-guard', { verdict: 'nudge', backend: d.backend, rule, tier });
  allow(
    `multi-model-team: this spawned task routes to ${beDisp} [rule=${rule}, tier=${tier}] per your config. ` +
    `Prefer dispatching it through the plugin CLI — ${how} — so it runs on ${d.backend} and saves Claude ` +
    `tokens, instead of doing the work in this Claude agent. Configurable nudge: ignore it if ` +
    `the task needs your in-context judgment or codebase awareness. ` +
    `(Set [proactive].enforce_spawns=true to make this a hard requirement.)`
  );
}

main().catch(() => { /* fail-open: emit nothing -> tool proceeds */ });
