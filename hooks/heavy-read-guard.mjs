#!/usr/bin/env node
// heavy-read-guard.mjs — PreToolUse(Read) guard (Node ESM port of heavy-read-guard.sh).
//
// Fires only when Claude is about to Read a LARGE file with an RE/dump-ish extension; in that case
// it DENIES the direct read and tells Claude to delegate the ingestion. Everything else is allowed.
// ALWAYS-ON (not proactive-gated). Fail-OPEN: any uncertainty -> allow (never wrongly block).
//
// ONE node process, ZERO child forks (the bash version forked cat + python + wc + tr + python).
//
// Tunables (env):
//   MMT_HOOK_MAX_BYTES   size threshold in bytes      (default 51200 = 50 KiB)
//   MMT_HOOK_EXTS        space-separated extensions   (default "dump il2cpp bin dmp sym pb")
//   MMT_HOOK_DISABLE     set to 1 to disable entirely

import fs from 'node:fs';
import path from 'node:path';
import { readPayload, deny, debugMark, hookDisabled } from '../src/lib/hook-common.mjs';

async function main() {
  if (hookDisabled()) return; // disabled -> silent allow (no output)

  const payload = await readPayload();
  if (!payload) return; // nothing to inspect -> allow

  const maxBytes = parseInt(process.env.MMT_HOOK_MAX_BYTES || '51200', 10);
  const exts = (process.env.MMT_HOOK_EXTS || 'dump il2cpp bin dmp sym pb')
    .split(/\s+/)
    .filter(Boolean)
    .map((e) => e.toLowerCase());

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return; // no path -> allow

  // Not a readable regular file (e.g. about to be created) -> allow.
  let size;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    size = st.size;
  } catch {
    return;
  }

  // Extension check (case-insensitive, basename's last dot segment — matches bash `${base##*.}`).
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  const ext = (dot >= 0 ? base.slice(dot + 1) : base).toLowerCase();
  if (!exts.includes(ext)) return; // not a guarded extension -> allow

  // Size check.
  if (!(size > maxBytes)) return; // small enough -> allow

  const kib = Math.floor(size / 1024);
  const dir = path.dirname(filePath);
  const reason =
    `multi-model-team: '${base}' is ${kib} KiB. Reading it straight into context is ` +
    `token-expensive. Delegate the ingestion instead: spawn the bulk-summarizer agent (or run ` +
    `node "$CLAUDE_PLUGIN_ROOT/src/bin/run.mjs" --add-dir "${dir}") so agy reads ` +
    `it on Google's quota and returns a compact, grounded extract. If you truly need the raw ` +
    `bytes (e.g. precise RE work), re-issue the Read -- this guard only fires once per call.`;

  debugMark('heavy-read-guard', { file: base, kib, ext });
  deny(reason);
}

main().catch(() => { /* fail-open: emit nothing -> tool proceeds */ });
