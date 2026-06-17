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
 * Build the executor command block for the agent body.
 * dispatch 'forced' pins backend+tier via --decision JSON.
 * dispatch 'route'  lets run.mjs auto-route.
 * Both reference `node "…/src/bin/run.mjs"` (retiring bash scripts/run.sh).
 */
function _dispatchBlock(name, spec) {
  const backend = spec.backend ?? 'agy';
  const tier = spec.tier ?? 'standard';
  if (spec.dispatch === 'forced') {
    const decision = JSON.stringify({
      backend,
      model: '',
      tier,
      rule: `${name}-forced`,
      native: false,
    });
    // base64url the decision JSON: the single-line `--decision-b64=<token>` form has no quotes and
    // no line-continuation, so it survives verbatim in BOTH PowerShell and bash (single-quoted JSON
    // + `\` continuation mangles under PowerShell — the Windows default — and silently falls through
    // to native). run.mjs decodes it in-Node, never via a shell.
    const b64 = Buffer.from(decision).toString('base64url');
    return `node "\${CLAUDE_PLUGIN_ROOT}/src/bin/run.mjs" --decision-b64=${b64} "<the full task text>"`;
  }
  return `node "\${CLAUDE_PLUGIN_ROOT}/src/bin/run.mjs" "<the full task text>"`;
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
  const dispatch = _dispatchBlock(name, spec);

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
    `2. Run the executor:\n` +
    `\n` +
    `   \`\`\`bash\n` +
    `   ${dispatch}\n` +
    `   \`\`\`\n` +
    `\n` +
    `   - If the task references a local file/dir the backend should read itself, add\n` +
    `     \`--add-dir "<dir>"\` so the backend reads it on its own quota instead of through Claude.\n` +
    `   - Pass the task as a single quoted argument. Do not add commentary to the prompt.\n` +
    `3. Interpret the output:\n` +
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
