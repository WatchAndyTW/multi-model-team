/**
 * gen-agents.mjs — (re)generate agents/<name>.md from roster.json agents section.
 * Node ESM port of scripts/lib/gen_agents.py. Zero runtime dependencies.
 *
 * Exports:
 *   generateAgents(roster, agentsDir)
 *     roster    — parsed roster object (from loadRoster)
 *     agentsDir — path to the agents/ directory (written in-place)
 *     Enabled agents: write agents/<name>.md with GENERATED header + frontmatter + relay body.
 *     Disabled agents: remove agents/<name>.md if it exists.
 *     dispatch 'route'  -> body uses `node "…/src/bin/run.mjs" "<task>"`
 *     dispatch 'forced' -> body uses `node run.mjs --decision '{"backend":…}'`
 *
 * GENERATED comment matches the original Python generator comment (parity).
 * Edit config/roster.json then call generateAgents() — do NOT hand-edit the .md files.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents as getAgents } from './config.mjs';

// ─── constants ───────────────────────────────────────────────────────────────

const GEN_NOTE =
  '<!-- GENERATED from config/roster.json by src/lib/gen-agents.mjs — edit the JSON\n' +
  '     (agents.<name>), then re-run the generator. Do not hand-edit this file. -->';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Wrap a role string into a YAML folded block scalar (2-space indented continuation lines).
 * Parity with gen_agents.py _wrap_description (width=92).
 */
function _wrapDescription(role) {
  const width = 92;
  const words = role.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines.push('');
  return lines.map(l => '  ' + l).join('\n');
}

/**
 * Build the executor instruction block for the agent body.
 *
 * File transport (no base64, no command-line task text): the agent WRITES a call file under
 * .mmt/calls/ with the Write tool (the untrusted task text never touches a shell), then runs
 * `node run.mjs --call-file=<path>`. The path is the only thing on the command line — a safe
 * [A-Za-z0-9_/.-] token that survives verbatim in BOTH PowerShell (the Windows default) and bash,
 * fixing the old single-quoted-JSON / heredoc mangling that silently fell through to native.
 *
 * dispatch 'forced' pins backend+tier in the call file's decision.
 * dispatch 'route'  omits the decision so run.mjs auto-routes (task only).
 * Returns { writeContent, command } — writeContent is null for the route case's task-only file.
 */
function _dispatchBlock(name, spec) {
  const backend = spec.backend ?? 'agy';
  const tier = spec.tier ?? 'standard';
  const callPath = '.mmt/calls/<a-short-unique-name>.json';
  if (spec.dispatch === 'forced') {
    const callJson = JSON.stringify({
      decision: { backend, model: '', tier, rule: `${name}-forced`, native: false },
      task: '<the full task text>',
    }, null, 2);
    return {
      writeContent: callJson,
      command: `node "\${CLAUDE_PLUGIN_ROOT}/src/bin/run.mjs" --call-file="${callPath}"`,
    };
  }
  // route: no forced decision — write a call file with just the task; run.mjs auto-routes.
  const callJson = JSON.stringify({ task: '<the full task text>' }, null, 2);
  return {
    writeContent: callJson,
    command: `node "\${CLAUDE_PLUGIN_ROOT}/src/bin/run.mjs" --call-file="${callPath}"`,
  };
}

/**
 * Render the full .md content for one agent entry.
 * Parity with gen_agents.py render().
 */
function _render(name, spec) {
  const backend = spec.backend ?? 'agy';
  const tier = spec.tier ?? 'standard';
  const model = spec.model ?? 'haiku';
  const color = spec.color ?? 'blue';
  const role = (spec.role ?? '') || `Delegation agent ${name}.`;
  const forced = spec.dispatch === 'forced';
  const { writeContent, command } = _dispatchBlock(name, spec);

  let intro, handoff, rules;

  if (forced) {
    intro =
      `You are the **${name}** dispatcher for the multi-model-team plugin. You do **not** solve ` +
      `tasks yourself — you relay every task to the **${backend}** backend (**${tier}** tier) ` +
      `through the plugin's scripts and return the result verbatim. This backend is the ` +
      `orchestrator's **explicit choice** (spawning you *is* the decision): you run the task ` +
      `there and do **not** re-route, downgrade, or refuse it based on the task's content.`;
    handoff =
      `If stdout begins with \`MMT_NATIVE_HANDOFF\`, the **${backend}** CLI was ` +
      `unavailable/exhausted (it fell through the fallback chain) — return that sentinel ` +
      `verbatim so the orchestrator (Opus/Sonnet) handles it in-context.`;
    rules =
      `- The orchestrator chose **${backend}** on purpose. Run the task as dispatched — do ` +
      `**NOT** self-reject or re-route based on content (no "this looks like RE, I'll bounce ` +
      `it"). CLI backends are weaker on reverse-engineering / systems-hard work, but that ` +
      `trade-off is the caller's call, not yours.\n` +
      `- Do not edit files or run anything except the plugin scripts above. You are a relay.`;
  } else {
    intro =
      `You are the **${name}** dispatcher for the multi-model-team plugin. You do **not** solve ` +
      `tasks yourself — you relay them through the plugin's scripts and return the result ` +
      `verbatim. The **router** decides where work goes (it may keep hard/systems work native); ` +
      `you never force an offload beyond what it picks.`;
    handoff =
      `If stdout begins with \`MMT_NATIVE_HANDOFF\`, the router chose native Claude (or the ` +
      `backend was unavailable/exhausted) — return that sentinel verbatim so the orchestrator ` +
      `(Opus/Sonnet) handles it in-context.`;
    rules =
      `- Let the router decide: do not force a backend it didn't pick.\n` +
      `- Do not edit files or run anything except the plugin scripts above. You are a relay.`;
  }

  return (
    `---\n` +
    `name: ${name}\n` +
    `description: >-\n` +
    `${_wrapDescription(role)}\n` +
    `tools: Bash\n` +
    `model: ${model}\n` +
    `color: ${color}\n` +
    `---\n` +
    `\n` +
    `${GEN_NOTE}\n` +
    `\n` +
    `${intro}\n` +
    `\n` +
    `## What to do\n` +
    `\n` +
    `1. Take the task text you were given.\n` +
    `2. With the **Write tool** (not a shell command), write a call file under \`.mmt/calls/\` —\n` +
    `   give it a short unique name and put the task text in the \`"task"\` field. The untrusted task\n` +
    `   text goes in the FILE, never on a command line (the Write tool creates parent dirs):\n` +
    `\n` +
    `   \`\`\`json\n` +
    `${writeContent.split('\n').map((l) => '   ' + l).join('\n')}\n` +
    `   \`\`\`\n` +
    `\n` +
    `3. Run the executor, passing only the file path (substitute the name you chose):\n` +
    `\n` +
    `   \`\`\`bash\n` +
    `   ${command}\n` +
    `   \`\`\`\n` +
    `\n` +
    `   - If the task references a local file/dir the backend should read itself, add\n` +
    `     \`--add-dir "<dir>"\` so the backend reads it on its own quota instead of through Claude.\n` +
    `   - Do NOT inline the task on the command line and do NOT add commentary to the prompt.\n` +
    `   - **Run it in the FOREGROUND and WAIT.** The ${backend} CLI can take MANY MINUTES on a hard\n` +
    `     task; run.mjs blocks until it finishes (its own generous timeout SIGKILLs the CLI on expiry).\n` +
    `     Do NOT background it (no \`&\`, no \`run_in_background\`), do NOT wrap it in your own\n` +
    `     \`sleep\`/\`timeout\`/\`tail -f\`, and do NOT give up early — a slow response is NOT a failure.\n` +
    `   - **If your shell hits ITS OWN time limit before the command returns, do NOT immediately\n` +
    `     re-run it** — re-running spawns a SECOND ${backend} process while the first is still working.\n` +
    `     Instead read \`<the call-file>.status.json\` ({state:"running"|"done"|"failed"}, updated ~10s):\n` +
    `     state:"running" → keep WAITING (re-read the status file, do NOT re-run) UNLESS it is stale\n` +
    `     (elapsed_ms stops advancing across two ~15s reads → run.mjs died); "done"/"failed" → act on\n` +
    `     it; status missing or stale → re-run the command at most ONCE. Never loop the command.\n` +
    `4. Interpret the output:\n` +
    `   - ${handoff}\n` +
    `   - Otherwise stdout **is** the delegated result. Return it **verbatim** — no analysis, no\n` +
    `     reformatting, no preamble.\n` +
    `   - On a nonzero exit with no usable output, return stderr verbatim and stop.\n` +
    `\n` +
    `## Hard rules\n` +
    `\n` +
    `${rules}\n`
  );
}

// ─── generateAgents ──────────────────────────────────────────────────────────

/**
 * Write or remove agents/<name>.md for each entry in roster.agents.
 *
 * @param {object} roster    Parsed roster object (from loadRoster)
 * @param {string} agentsDir Path to the agents/ directory
 * @returns {{ wrote: string[], removed: string[], skipped: string[] }}
 */
export function generateAgents(roster, agentsDir) {
  mkdirSync(agentsDir, { recursive: true });

  const agentsMap = getAgents(roster);
  const wrote = [];
  const removed = [];
  const skipped = [];

  for (const [name, spec] of Object.entries(agentsMap)) {
    if (!spec || typeof spec !== 'object') continue;  // skip _comment / non-object
    const mdPath = join(agentsDir, `${name}.md`);

    if (spec.enabled) {
      const content = _render(name, spec);
      writeFileSync(mdPath, content, { encoding: 'utf8' });
      wrote.push(name);
    } else {
      if (existsSync(mdPath)) {
        rmSync(mdPath);
        removed.push(name);
      } else {
        skipped.push(name);
      }
    }
  }

  return { wrote, removed, skipped };
}

// ─── CLI: `node src/lib/gen-agents.mjs [agentsDir]` regenerates agents/*.md from roster.json ───
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadRoster } from './config.mjs';
import { resolveRosterPath } from './platform.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const arg = process.argv[2];
  // A flag-looking positional (e.g. --help) must NOT be taken as the output dir (it would create a
  // literal `--help/` directory). Print usage for --help/-h; ignore any other leading-dash token.
  if (arg === '--help' || arg === '-h') {
    console.log('Usage: node src/lib/gen-agents.mjs [agentsDir]\n  Regenerates agents/*.md from the resolved roster (.mmt/roster.json > ~/.claude/mmt-roster.json > plugin default).\n  agentsDir defaults to <repo>/agents.');
    process.exit(0);
  }
  const rosterPath = resolveRosterPath(root);
  const agentsDir = (arg && !arg.startsWith('-')) ? arg : join(root, 'agents');
  const { wrote, removed, skipped } = generateAgents(loadRoster(rosterPath), agentsDir);
  console.log(
    `gen-agents: wrote [${wrote.join(', ')}] removed [${removed.join(', ')}] skipped [${skipped.join(', ')}] -> ${agentsDir}`,
  );
}
