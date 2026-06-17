#!/usr/bin/env node
// proactive-route.mjs — UserPromptSubmit hook (Node ESM port of proactive-route.sh).
//
// When proactive.enabled is true in roster.json, every submitted prompt the router would send to
// agy gets a one-shot reminder injected (additionalContext) nudging Claude to DELEGATE it instead
// of solving inline. Deterministic firing; compliance stays Claude's judgment. The prompt text is
// NEVER echoed back into the reminder.
//
// OFF by default. Fail-SILENT (no nudge) on any uncertainty. ONE node process, ZERO child forks
// (the bash version forked cat + python×3 + route.sh's own fork storm + wc + tr). Hard override:
// MMT_PROACTIVE_DISABLE=1.

import fs from 'node:fs';
import {
  readPayload, promptContext, decideTask, debugMark,
  proactiveGate, proactiveDisabled, hookDisabled,
  rosterPath, tagsPath, pluginRootFrom, withinWindow, ruleAllowed,
} from '../src/lib/hook-common.mjs';
import { loadRoster } from '../src/lib/config.mjs';
import { charCount } from '../src/lib/score.mjs';

async function main() {
  if (proactiveDisabled() || hookDisabled()) return;

  const payload = await readPayload();
  if (!payload) return;

  const root = pluginRootFrom(import.meta.url);
  const rPath = rosterPath(root);
  if (!fs.existsSync(rPath)) return;

  let roster;
  try { roster = loadRoster(rPath); } catch { return; }

  // Authoritative config parse (REAL JSON, no substring gate).
  const p = proactiveGate(roster);
  if (!p.enabled) return;

  // Extract the user's prompt.
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const trimmed = prompt.replace(/^\s+/, '');
  if (!trimmed) return;
  if (trimmed.startsWith('/')) return; // slash commands route themselves

  // Size window (chars). 0 disables a bound.
  const chars = charCount(prompt);
  if (!withinWindow(chars, p.min_chars, p.max_chars)) return;

  // Route in-process (no route.sh fork). Feed the prompt as data only — never echoed back.
  const d = decideTask(prompt, { roster, tagsPath: tagsPath(root) });
  if (!d || d.backend !== 'agy') return; // only nudge for agy-routable work

  // Optional rule allowlist (CSV). Empty = any agy rule.
  if (!ruleAllowed(p.rules, d.rule)) return;

  const rule = d.rule || '?';
  const tier = d.tier || '?';
  const ctx =
    `multi-model-team: this request routes to agy (Gemini) [rule=${rule}, tier=${tier}]. ` +
    'If it is a standalone, verifiable task, prefer delegating it — spawn the `multi-model-team:agy` ' +
    'agent (or run `/team`) so it runs on agy and saves Claude tokens — instead of solving it inline. ' +
    'This is a configurable nudge, not a rule: ignore it if the task needs your in-context judgment, ' +
    'codebase awareness, or is part of a larger change you are already making.';

  debugMark('proactive-route', { rule, tier });
  promptContext(ctx);
}

main().catch(() => { /* fail-silent */ });
