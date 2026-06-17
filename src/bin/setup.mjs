#!/usr/bin/env node
/**
 * setup.mjs — scaffold the user's personal roster at ~/.claude/mmt-roster.json.
 *
 * Backs the /mmt-setup command. Seeds ~/.claude/mmt-roster.json from the shipped plugin default
 * (config/roster.json) so the user has a complete, editable config that every entry point picks up
 * automatically (resolution: <cwd>/.mmt/roster.json > ~/.claude/mmt-roster.json > plugin default).
 *
 * Safe by default: REFUSES to overwrite an existing ~/.claude/mmt-roster.json unless --force is
 * given (so re-running never clobbers your tuning). Creates ~/.claude if absent.
 *
 * Usage:
 *   node src/bin/setup.mjs              # create ~/.claude/mmt-roster.json (no-op if it exists)
 *   node src/bin/setup.mjs --force      # overwrite an existing one with a fresh copy of the default
 *   node src/bin/setup.mjs --print-path # just print the target path and exit
 *
 * Zero runtime deps (Node stdlib only). ESM, win32/linux/darwin.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userRosterPath } from '../lib/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DEFAULT = resolve(__dirname, '..', '..', 'config', 'roster.json');

function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const target = userRosterPath();

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node src/bin/setup.mjs [--force] [--print-path]\n' +
      '  Creates ~/.claude/mmt-roster.json (seeded from the plugin default roster).\n' +
      '  --force       overwrite an existing personal roster with a fresh default copy\n' +
      '  --print-path  print the target path and exit\n',
    );
    process.exit(0);
  }

  if (argv.includes('--print-path')) {
    process.stdout.write(target + '\n');
    process.exit(0);
  }

  const existed = existsSync(target);
  if (existed && !force) {
    process.stdout.write(
      `MMT_SETUP: ~/.claude/mmt-roster.json already exists — leaving it untouched.\n` +
      `  path: ${target}\n` +
      `  (edit it directly, or re-run with --force to reset it to the shipped default.)\n`,
    );
    process.exit(0);
  }

  let defaultRoster;
  try {
    defaultRoster = readFileSync(PLUGIN_DEFAULT, 'utf8');
  } catch (e) {
    process.stderr.write(`MMT_SETUP: cannot read plugin default roster at ${PLUGIN_DEFAULT}: ${e.message}\n`);
    process.exit(1);
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, defaultRoster, 'utf8');
  } catch (e) {
    process.stderr.write(`MMT_SETUP: failed to write ${target}: ${e.message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `MMT_SETUP: ${existed ? 'reset' : 'created'} your personal roster.\n` +
    `  path: ${target}\n` +
    `  Edit it to tune backends / routes / team / reasoning. Resolution order:\n` +
    `    <cwd>/.mmt/roster.json  >  ~/.claude/mmt-roster.json  >  plugin default\n`,
  );
  process.exit(0);
}

main();
