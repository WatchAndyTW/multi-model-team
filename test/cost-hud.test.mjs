import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(
  os.tmpdir(),
  `mmt-cost-hud-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test('HUD accumulates cost micros and renders $ figure', async () => {
  const previousStateFile = process.env.MMT_STATE_FILE;
  process.env.MMT_STATE_FILE = stateFile;

  try {
    const { start, end } = await import('../src/lib/state.mjs');

    start({ id: 'cost-hud-1', backend: 'test', model: 'test-model', rule: 'test', inChars: 10 });
    end({
      id: 'cost-hud-1',
      backend: 'test',
      model: 'test-model',
      rule: 'test',
      code: 0,
      durMs: 1,
      outChars: 20,
      fallback: 0,
      costMicros: 40000,
    });

    start({ id: 'cost-hud-2', backend: 'test', model: 'test-model', rule: 'test', inChars: 30 });
    end({
      id: 'cost-hud-2',
      backend: 'test',
      model: 'test-model',
      rule: 'test',
      code: 0,
      durMs: 2,
      outChars: 40,
      fallback: 0,
      costMicros: 360000,
    });

    const rawState = await fs.readFile(stateFile, 'utf8');
    const match = rawState.match(/"approx_cost_micros"\s*:\s*(\d+)/);
    assert.ok(match, `state file did not contain approx_cost_micros: ${rawState}`);
    assert.equal(Number(match[1]), 400000);

    const statuslinePath = path.join(__dirname, '..', 'statusline', 'statusline.mjs');
    const { stdout } = await execFileAsync(process.execPath, [statuslinePath], {
      env: { ...process.env, MMT_STATE_FILE: stateFile },
      windowsHide: true,
    });

    assert.match(stdout, /\$0\.40/);
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.MMT_STATE_FILE;
    } else {
      process.env.MMT_STATE_FILE = previousStateFile;
    }
    await fs.rm(stateFile, { force: true });
  }
});
