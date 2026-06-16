#!/usr/bin/env node
/**
 * setup.mjs — one-shot installer + re-sync for the multi-model-team proactive config.
 *
 * The proactive nudges live in roster.json (a TRACKED plugin file), so editing the cached
 * roster is wiped on every plugin update. The durable pattern is an EXTERNAL roster outside the
 * cache, pointed at by the MMT_ROSTER env var (set in ~/.claude/settings.json). This script
 * automates that setup and the periodic re-sync.
 *
 * Modes:
 *   (default)  setup  — write/refresh the external roster (proactive ENABLED), then wire
 *                       MMT_ROSTER into ~/.claude/settings.json. Idempotent.
 *   --sync            — refresh the external roster FROM the plugin roster while PRESERVING the
 *                       external file's [proactive] block (your toggles). Does NOT touch settings.
 *   --status          — print the current external-roster proactive state + settings wiring.
 *
 * Flags:
 *   --enforce | --nudge   set proactive.enforce_spawns true/false (default: keep existing; new=false)
 *   --disable             set proactive.enabled=false (keeps the settings wiring in place)
 *   --no-settings         do everything except patch settings.json
 *   --roster <path>       external roster path  (default: $MMT_ROSTER or ~/.claude/mmt-roster.json)
 *   --settings-file <p>   settings.json path    (default: ~/.claude/settings.json)
 *   -h | --help
 *
 * Zero runtime deps (Node stdlib only). The base roster is always the PLUGIN's config/roster.json
 * (so new upstream backends/routes flow in on --sync); only the [proactive] block is user-owned.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Plugin root: explicit env (set when run as a /command) else resolve from this file (src/bin -> root).
function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function parseArgs(argv) {
  const a = {
    mode: 'setup', enable: undefined, enforce: undefined, settings: true,
    rosterOut: '', settingsPath: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--sync') { a.mode = 'sync'; a.settings = false; }
    else if (t === '--status') { a.mode = 'status'; }
    else if (t === '--enable') { a.enable = true; }
    else if (t === '--disable') { a.enable = false; }
    else if (t === '--enforce') { a.enforce = true; }
    else if (t === '--nudge' || t === '--no-enforce') { a.enforce = false; }
    else if (t === '--no-settings') { a.settings = false; }
    else if (t === '--roster') { a.rosterOut = argv[++i] || ''; }
    else if (t.startsWith('--roster=')) { a.rosterOut = t.slice('--roster='.length); }
    else if (t === '--settings-file') { a.settingsPath = argv[++i] || ''; }
    else if (t.startsWith('--settings-file=')) { a.settingsPath = t.slice('--settings-file='.length); }
    else if (t === '-h' || t === '--help') { a.mode = 'help'; }
    // unknown tokens are ignored (the /command forwards $ARGUMENTS verbatim)
  }
  return a;
}

const HELP = `multi-model-team setup — durable proactive config via an external MMT_ROSTER.

Usage: node src/bin/setup.mjs [mode] [flags]
  (default)        enable proactive + wire MMT_ROSTER into ~/.claude/settings.json
  --sync           refresh external roster from the plugin, preserving your [proactive] toggles
  --status         show current state

  --enforce        hard-deny CLI-routable agent spawns (vs soft nudge)
  --nudge          soft nudge only (enforce_spawns=false)
  --disable        turn proactive off (keeps settings wiring)
  --no-settings    don't modify settings.json
  --roster <path>  external roster path (default: $MMT_ROSTER or ~/.claude/mmt-roster.json)
  --settings-file <path>   settings.json path (default: ~/.claude/settings.json)`;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Patch settings.json: add/update env.MMT_ROSTER, preserving every other key. Fail SAFE — if the
// file exists but isn't valid JSON, do NOT overwrite it (the user would lose their settings).
function wireSettings(settingsPath, rosterOut) {
  let s = {};
  if (fs.existsSync(settingsPath)) {
    try { s = readJson(settingsPath); }
    catch (e) {
      return { ok: false, reason: `settings.json is not valid JSON (${e.message}); not modifying it — add env.MMT_ROSTER manually.` };
    }
  }
  if (!s.env || typeof s.env !== 'object') s.env = {};
  const before = s.env.MMT_ROSTER;
  s.env.MMT_ROSTER = rosterOut;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  return { ok: true, changed: before !== rosterOut, before: before || null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') { console.log(HELP); return 0; }

  const HOME = os.homedir();
  const CLAUDE_DIR = path.join(HOME, '.claude');
  const DEFAULT_ROSTER = path.join(CLAUDE_DIR, 'mmt-roster.json');
  // Target the file MMT_ROSTER already points at (so re-runs update the right file), else the default.
  const rosterOut = args.rosterOut || process.env.MMT_ROSTER || DEFAULT_ROSTER;
  const settingsPath = args.settingsPath || path.join(CLAUDE_DIR, 'settings.json');
  const pluginRosterPath = path.join(pluginRoot(), 'config', 'roster.json');

  // ---- status ---------------------------------------------------------------
  if (args.mode === 'status') {
    let ext = null, settings = null;
    try { ext = readJson(rosterOut); } catch { /* missing/invalid */ }
    try { settings = readJson(settingsPath); } catch { /* missing/invalid */ }
    const p = (ext && ext.proactive) || {};
    console.log(`multi-model-team setup status`);
    console.log(`  external roster : ${rosterOut} ${ext ? '(present)' : '(MISSING)'}`);
    if (ext) {
      console.log(`    proactive.enabled        = ${p.enabled === true}`);
      console.log(`    proactive.guard_spawns   = ${p.guard_spawns !== false}`);
      console.log(`    proactive.enforce_spawns = ${p.enforce_spawns === true}`);
    }
    const wired = settings && settings.env && settings.env.MMT_ROSTER;
    console.log(`  settings.json   : ${settingsPath}`);
    console.log(`    env.MMT_ROSTER = ${wired || '(not set)'}`);
    if (wired && wired !== rosterOut) console.log(`    NOTE: settings points at a DIFFERENT roster than this run's target.`);
    return 0;
  }

  // ---- load base (always the plugin roster) ---------------------------------
  let base;
  try { base = readJson(pluginRosterPath); }
  catch (e) { console.error(`setup: cannot read plugin roster at ${pluginRosterPath}: ${e.message}`); return 1; }

  // ---- resolve the [proactive] block ----------------------------------------
  // Start from the plugin defaults, then overlay the existing external file's proactive block so a
  // re-sync/re-run preserves the user's toggles (rules, caps, enforce, ...).
  const existed = fs.existsSync(rosterOut);
  let proactive = { ...(base.proactive || {}) };
  if (existed) {
    try { const prev = readJson(rosterOut); if (prev && prev.proactive) proactive = { ...proactive, ...prev.proactive }; }
    catch { /* unreadable external -> fall back to plugin defaults */ }
  }

  // enabled: explicit flag wins; else setup forces ON; else sync preserves (new file -> ON).
  proactive.enabled = args.enable !== undefined
    ? args.enable
    : (args.mode === 'setup' ? true : (existed ? proactive.enabled === true : true));
  if (args.enforce !== undefined) proactive.enforce_spawns = args.enforce;

  // ---- write the external roster --------------------------------------------
  const out = { ...base, proactive };
  out._about = 'EXTERNAL multi-model-team roster (pointed at by MMT_ROSTER in ~/.claude/settings.json). '
    + 'Lives outside the plugin cache so it survives plugin updates. The base is copied from the plugin '
    + "roster; only the [proactive] block is yours. Re-sync after a plugin update with: "
    + 'node "$CLAUDE_PLUGIN_ROOT/src/bin/setup.mjs" --sync  (refreshes the base, keeps your [proactive] toggles).';
  fs.mkdirSync(path.dirname(rosterOut), { recursive: true });
  fs.writeFileSync(rosterOut, JSON.stringify(out, null, 2) + '\n');

  const lines = [];
  lines.push(`${args.mode === 'sync' ? 're-synced' : 'wrote'} external roster: ${rosterOut}`);
  lines.push(`  proactive.enabled=${proactive.enabled === true} guard_spawns=${proactive.guard_spawns !== false} enforce_spawns=${proactive.enforce_spawns === true}`);

  // ---- wire settings.json ----------------------------------------------------
  let restartNeeded = false;
  if (args.settings) {
    const r = wireSettings(settingsPath, rosterOut);
    if (!r.ok) { lines.push(`settings: ${r.reason}`); }
    else if (r.changed) { lines.push(`set env.MMT_ROSTER in ${settingsPath}`); restartNeeded = true; }
    else { lines.push(`settings already wired (env.MMT_ROSTER -> ${rosterOut})`); }
  } else {
    lines.push(`(left settings.json untouched)`);
  }

  console.log(lines.join('\n'));
  if (restartNeeded) console.log('\nRESTART Claude Code for the MMT_ROSTER env var to take effect.');
  return 0;
}

process.exit(main());
