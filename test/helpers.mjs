// helpers.mjs — shared test fixtures for the Node ESM suite.
//
// Resolves repo paths relative to this file (test/ -> repo root) and exposes the
// loaded roster + tags path so every test imports modules directly (fast, no fork).

import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
export const STATUSLINE = join(ROOT, 'statusline', 'statusline.mjs');

/** Make a throwaway temp dir (auto-namespaced). */
export function tmp(prefix = 'mmt-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Turn OFF every CLI backend in a roster clone.
 *
 * Tests that mean "no CLI is available, so the run must hand off to native" must disable them ALL,
 * not just the ones that existed when the test was written. Naming backends individually made the
 * suite silently spawn a REAL CLI the moment a new backend shipped enabled (opencode did exactly
 * that: the offline suite hung for minutes waiting on a live model). Iterating the roster keeps
 * these tests offline no matter how many backends exist.
 * @param {object} clone a roster object (mutated in place)
 */
export function disableAllBackends(clone) {
  const backends = (clone && clone.backends) || {};
  for (const [name, be] of Object.entries(backends)) {
    if (name.startsWith('_') || !be || typeof be !== 'object') continue;
    be.enabled = false;
  }
  return clone;
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
 * @param {object} opts    { args?:string[], input?:string, env?:object, cwd?:string }
 * @returns {{ stdout:string, stderr:string, code:number }}
 */
export function runNode(script, { args = [], input = '', env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input,
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    code: typeof r.status === 'number' ? r.status : (r.signal ? 1 : 0),
  };
}
