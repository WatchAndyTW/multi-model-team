#!/usr/bin/env node
// command-fanout-guard.mjs — UserPromptSubmit hook for /reasoning and /team correctness.
//
// This is a HARD command-correctness guard, NOT the opt-in proactive nudge. It is intentionally
// NOT gated on proactive.enabled (that nudge is off by default and deliberately skips slash
// commands — see proactive-route.mjs:43). The defect this closes: /reasoning and /team are
// prompt-only orchestration, so Claude can skip loading config + skip the Workflow/relay path and
// just answer with native Claude analysis, never reaching the agy/codex CLIs. This injects a
// mandatory directive (additionalContext) for those commands so Claude enters the deterministic
// engine before answering.
//
// ONE node process, ZERO child forks. Fail-SILENT on any uncertainty. The prompt text is NEVER
// echoed back into the directive (injection hygiene). Kill switches: MMT_HOOK_DISABLE=1 (all hooks)
// and MMT_COMMAND_GUARD_DISABLE=1 (just this guard).

import {
  readPayload, promptContext, debugMark, hookDisabled,
} from '../src/lib/hook-common.mjs';

/** MMT_COMMAND_GUARD_DISABLE=1 -> just this guard off. */
function commandGuardDisabled() {
  return process.env.MMT_COMMAND_GUARD_DISABLE === '1';
}

// Match ONLY this plugin's /reasoning and /team (bare or multi-model-team:-namespaced), case-
// insensitive, allowing leading whitespace. The (?=\s|$) boundary prevents matching another
// plugin's command (e.g. oh-my-claudecode:team) or a longer word (/teammate).
function matchCommand(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const match = /^\s*\/(?:multi-model-team:)?(reasoning|team)(?=\s|$)/i.exec(text);
  return match ? match[1].toLowerCase() : '';
}

function directiveFor(command) {
  if (command === 'reasoning') {
    return [
      'multi-model-team /reasoning MANDATORY ENGINE PATH:',
      '1. First run the reasoning config-load Bash command exactly as documented for this command.',
      '2. Then enter the deterministic Fusion engine: use Workflow when available; otherwise use the scripted reason.mjs path or explicit faithful-relay Task panelists.',
      '3. Do NOT answer with native Claude analysis before the engine runs, and do NOT replace CLI panelists with plain native Task agents.',
      '4. Every gemini/codex CLI panelist MUST be produced by `node src/bin/run.mjs --decision \'{...,"native":false}\'` through the relay path.',
      '5. No dress-up contract: a `gemini:` or `codex:` result must come from that CLI output, never from Claude writing under that label.',
      '6. If a CLI returns `MMT_NATIVE_HANDOFF`, report/handle the visible native fallback as documented; do not silently impersonate the CLI.',
    ].join('\n');
  }

  if (command === 'team') {
    return [
      'multi-model-team /team MANDATORY ENGINE PATH:',
      '1. First run the team config-load Bash command exactly as documented for this command, after parsing any cap spec.',
      '2. Then enter the deterministic team engine: use Workflow when available; otherwise use the scripted team.mjs path or explicit faithful-relay Task subtasks.',
      '3. Do NOT solve the task with native Claude analysis first, and do NOT replace CLI subtasks with plain native Task agents.',
      '4. Every gemini/codex CLI subtask MUST be produced by `node src/bin/run.mjs --decision \'{...,"native":false}\'` through the relay path.',
      '5. No dress-up contract: a `gemini:` or `codex:` result must come from that CLI output, never from Claude writing under that label.',
      '6. If a CLI returns `MMT_NATIVE_HANDOFF`, report/handle the visible native fallback as documented; do not silently impersonate the CLI.',
    ].join('\n');
  }

  return '';
}

async function main() {
  if (hookDisabled() || commandGuardDisabled()) return;

  const payload = await readPayload();
  if (!payload) return;

  const command = matchCommand(payload.prompt);
  if (!command) return;

  const ctx = directiveFor(command);
  if (!ctx) return;

  debugMark('command-fanout-guard', { command });
  promptContext(ctx);
}

main().catch(() => { /* fail-silent */ });
