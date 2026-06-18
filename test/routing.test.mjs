// routing.test.mjs — port of run_tests.sh routing blocks.
// Asserts via router.decide() (in-process, fast) plus a few end-to-end `node route.mjs` stdin cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/lib/router.mjs';
import { ROSTER, TAGS_PATH, BIN_ROUTE, runNode } from './helpers.mjs';

const D = (task, preset) => decide({ task, roster: ROSTER, tagsPath: TAGS_PATH, preset });

function assertRoute(task, eb, et, er, preset) {
  const d = D(task, preset);
  assert.equal(d.backend, eb, `backend for "${task}": got ${d.backend} want ${eb} (rule=${d.rule})`);
  assert.equal(d.tier, et, `tier for "${task}": got ${d.tier} want ${et} (rule=${d.rule})`);
  assert.equal(d.rule, er, `rule for "${task}": got ${d.rule} want ${er}`);
}

test('hard line (Opus)', () => {
  assertRoute('Reverse engineer the IL2CPP dump and extract protobuf', 'native', 'opus', 're-injection-heavy');
  assertRoute('Write a DLL injection routine using MinHook detour', 'native', 'opus', 're-injection-heavy');
  assertRoute('Disassemble this function in IDA', 'native', 'opus', 're-injection-heavy');
  assertRoute('Write an unsafe FFI shim via pinvoke', 'native', 'opus', 're-injection-heavy');
  assertRoute('Design a lock-free concurrent queue with atomics', 'native', 'opus', 'systems-complex');
  assertRoute('Implement KCP reliable UDP congestion control', 'native', 'opus', 'systems-complex');
});

test('agy (offload)', () => {
  assertRoute('Create a new React component for the navbar', 'agy', 'standard', 'standard-coding');
  assertRoute('Write the CSS stylesheet for the landing page hero', 'agy', 'standard', 'standard-coding');
  assertRoute('Write a SQL query to join users and orders tables', 'agy', 'standard', 'standard-coding');
  assertRoute('Create mock fixture data for the user records', 'agy', 'standard', 'standard-coding');
  assertRoute('Watch this YouTube video and summarize the key points', 'agy', 'standard', 'multimodal');
  assertRoute('Write one line of bash to count files', 'agy', 'cheap', 'trivial');
});

test('codex (review / tests / verify)', () => {
  assertRoute('Review this PR diff for correctness and bugs', 'codex', 'standard', 'code-review-test');
  assertRoute('Add unit tests for the date parser', 'codex', 'standard', 'code-review-test');
  assertRoute('Write end-to-end tests for the checkout flow', 'codex', 'standard', 'code-review-test');
  assertRoute('Add integration tests for the auth module', 'codex', 'standard', 'code-review-test');
  assertRoute('Verify the implementation meets the spec', 'codex', 'standard', 'code-review-test');
  // A judgment word (refactor) still wins over codex -> Sonnet; integrate-verb too.
  assertRoute('Review and refactor the auth service', 'native', 'sonnet', 'judgment-coding');
  assertRoute('Integrate the Stripe API into the app', 'native', 'sonnet', 'judgment-coding');
});

test('bulk vs small summarize', () => {
  const big = `Summarize this log: ${'x'.repeat(25000)}`;
  assertRoute(big, 'agy', 'cheap', 'bulk-ingest');
  assertRoute('Summarize this short paragraph please', 'agy', 'standard', 'grounded-research');
});

test('sonnet (judgment / unclassified)', () => {
  assertRoute('Refactor the existing payment module to reduce dup', 'native', 'sonnet', 'judgment-coding');
  assertRoute('Fix the bug causing login to crash on empty input', 'native', 'sonnet', 'judgment-coding');
  assertRoute('Please take care of the thing from yesterday', 'native', 'sonnet', 'catch-all-safe');
});

test('regression: judgment work tripping a commodity noun stays on Sonnet', () => {
  assertRoute('Fix the bug where the login button does nothing on mobile', 'native', 'sonnet', 'judgment-coding');
  assertRoute('Fix the bug in our deployment script', 'native', 'sonnet', 'judgment-coding');
  assertRoute('Refactor the user service to extract a validation helper', 'native', 'sonnet', 'judgment-coding');
  assertRoute('Read through the codebase and refactor the auth module', 'native', 'sonnet', 'judgment-coding');
});

test('regression: OPUS hard-line regexes do NOT false-positive on everyday terms', () => {
  assert.equal(D('Refactor the component to use hooks').tier, 'sonnet');
  assert.equal(D('Set up dependency injection in the Spring controller').tier, 'sonnet');
  assert.equal(D('Add input sanitization to prevent SQL injection').tier, 'sonnet');
  assert.equal(D('Implement binary search over the sorted array').tier, 'sonnet');
  // config-logic must stay native (judgment), not leak to agy.
  assert.equal(D('Update the config file parsing logic to handle nested keys').backend, 'native');
  // tightened guards (P0): these everyday phrasings must NOT trip the Opus hard line.
  assert.notEqual(D('Read a binary file format and parse the header').tier, 'opus');
  assert.notEqual(D('Add React hooks into the API client for data fetching').tier, 'opus');
  assert.notEqual(D('Set up dependency injection with a DI container').tier, 'opus');
});

test('regression: real RE/injection signals STILL route to Opus', () => {
  assertRoute('Hook the render function with a detour trampoline', 'native', 'opus', 're-injection-heavy');
  assertRoute('Inject a payload into the target process memory', 'native', 'opus', 're-injection-heavy');
  assertRoute('Reverse engineer the binary and dump the exe', 'native', 'opus', 're-injection-heavy');
});

test('presets (budget / premium)', () => {
  assert.equal(D('Refactor the existing module', 'budget').backend, 'agy');
  assert.equal(D('Create a new React component', 'premium').backend, 'native');
});

// ── end-to-end: `node route.mjs` over stdin (injection-safe path) ───────────────
test('e2e route.mjs stdin: agy SQL task', () => {
  const { stdout, code } = runNode(BIN_ROUTE, { input: 'Write a SQL query to join users and orders tables\n' });
  assert.equal(code, 0);
  const d = JSON.parse(stdout);
  assert.equal(d.backend, 'agy');
  assert.equal(d.rule, 'standard-coding');
});

test('e2e route.mjs stdin: opus hard-line task', () => {
  const { stdout } = runNode(BIN_ROUTE, { input: 'Reverse engineer the IL2CPP dump and extract protobuf\n' });
  const d = JSON.parse(stdout);
  assert.equal(d.backend, 'native');
  assert.equal(d.tier, 'opus');
  assert.equal(d.rule, 're-injection-heavy');
});

test('e2e route.mjs --preset budget over stdin', () => {
  const { stdout } = runNode(BIN_ROUTE, { args: ['--preset', 'budget'], input: 'Refactor the existing module\n' });
  assert.equal(JSON.parse(stdout).backend, 'agy');
});

test('e2e route.mjs: no task -> non-zero exit', () => {
  const { code } = runNode(BIN_ROUTE, { input: '' });
  assert.notEqual(code, 0);
});
