// helpers.mjs — shared test fixtures for the Node ESM suite.
//
// Resolves repo paths relative to this file (test/ -> repo root) and exposes the
// loaded roster + tags path so every test imports modules directly (fast, no fork).

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadRoster } from '../src/lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');

export const ROSTER_PATH = join(ROOT, 'config', 'roster.json');
export const TAGS_PATH = join(ROOT, 'config', 'tags.txt');

export const ROSTER = loadRoster(ROSTER_PATH);

export const BIN_ROUTE = join(ROOT, 'src', 'bin', 'route.mjs');
export const BIN_RUN = join(ROOT, 'src', 'bin', 'run.mjs');
export const HOOK_HEAVY = join(ROOT, 'hooks', 'heavy-read-guard.mjs');
export const HOOK_PROACTIVE = join(ROOT, 'hooks', 'proactive-route.mjs');
export const HOOK_SPAWN = join(ROOT, 'hooks', 'spawn-route-guard.mjs');
export const STATUSLINE = join(ROOT, 'statusline', 'statusline.mjs');

/** Make a throwaway temp dir (auto-namespaced). */
export function tmp(prefix = 'mmt-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a roster variant: deep-clone the real roster, mutate via `fn`, write to `dir/name`. */
export function writeRosterVariant(dir, name, fn) {
  const clone = JSON.parse(JSON.stringify(ROSTER));
  if (fn) fn(clone);
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(clone), 'utf8');
  return p;
}

/**
 * Run a node script (a bin or a hook) capturing stdout.
 * @param {string} script  absolute path to the .mjs entry
 * @param {object} opts    { args?:string[], input?:string, env?:object }
 * @returns {{ stdout:string, stderr:string, code:number }}
 */
export function runNode(script, { args = [], input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    code: typeof r.status === 'number' ? r.status : (r.signal ? 1 : 0),
  };
}

export { readFileSync };
