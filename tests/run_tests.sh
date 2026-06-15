#!/usr/bin/env bash
# run_tests.sh — multi-model-team test suite.
#   ./tests/run_tests.sh          # offline: routing + unit tests (no agy calls)
#   MMT_LIVE=1 ./tests/run_tests.sh   # also run live agy smoke tests (network + agy)
set -uo pipefail

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MMT_ROOT
ROUTE="$MMT_ROOT/scripts/route.sh"
RUN="$MMT_ROOT/scripts/run.sh"
PY="$(command -v python3 || command -v python)"

PASS=0; FAIL=0; FAILED_NAMES=()
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
field() { printf '%s' "$1" | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('$2',''))" 2>/dev/null; }

# ---- assert helpers --------------------------------------------------------
assert_route() { # name task expect_backend expect_tier expect_rule
  local name="$1" task="$2" eb="$3" et="$4" er="$5"
  local d; d="$("$ROUTE" "$task" 2>/dev/null)"
  local b t r; b="$(field "$d" backend)"; t="$(field "$d" tier)"; r="$(field "$d" rule)"
  if [ "$b" = "$eb" ] && [ "$t" = "$et" ] && [ "$r" = "$er" ]; then ok "$name"
  else bad "$name" "got backend=$b tier=$t rule=$r ; want $eb/$et/$er"; fi
}
assert_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "got [$2] want [$3]"; }
assert_contains() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "[$2] missing [$3]";; esac; }

echo "── Routing: hard line (Opus) ──────────────────────────"
assert_route "il2cpp->opus"      "Reverse engineer the IL2CPP dump and extract protobuf"   native opus re-injection-heavy
assert_route "dll-inject->opus"  "Write a DLL injection routine using MinHook detour"       native opus re-injection-heavy
assert_route "disasm->opus"      "Disassemble this function in IDA"                          native opus re-injection-heavy
assert_route "ffi->opus"         "Write an unsafe FFI shim via pinvoke"                      native opus re-injection-heavy
assert_route "concurrency->opus" "Design a lock-free concurrent queue with atomics"         native opus systems-complex
assert_route "kcp->opus"         "Implement KCP reliable UDP congestion control"            native opus systems-complex

echo "── Routing: agy (offload) ─────────────────────────────"
assert_route "react->agy-std"    "Create a new React component for the navbar"              agy standard standard-coding
assert_route "css->agy-std"      "Write the CSS stylesheet for the landing page hero"       agy standard standard-coding
assert_route "sql->agy-std"      "Write a SQL query to join users and orders tables"        agy standard standard-coding
assert_route "fixture->agy-std"  "Create mock fixture data for the user records"             agy standard standard-coding
assert_route "video->agy-mm"     "Watch this YouTube video and summarize the key points"    agy standard multimodal
assert_route "oneliner->agy-chp" "Write one line of bash to count files"                    agy cheap trivial

echo "── Routing: codex (review / tests / verify) ───────────"
assert_route "review->codex"     "Review this PR diff for correctness and bugs"             codex standard code-review-test
assert_route "unittest->codex"   "Add unit tests for the date parser"                       codex standard code-review-test
assert_route "e2e->codex"        "Write end-to-end tests for the checkout flow"             codex standard code-review-test
assert_route "inttest->codex"    "Add integration tests for the auth module"                codex standard code-review-test
assert_route "verify->codex"     "Verify the implementation meets the spec"                 codex standard code-review-test
# Ordering: a judgment word (refactor/bugfix) still wins over codex -> Sonnet; integrate-verb too.
assert_route "review+refactor->sonnet" "Review and refactor the auth service"               native sonnet judgment-coding
assert_route "integrate->sonnet"       "Integrate the Stripe API into the app"              native sonnet judgment-coding

echo "── Routing: bulk vs small summarize ───────────────────"
BIG="Summarize this log: $(head -c 25000 /dev/zero | tr '\0' x)"
assert_route "bulk25k->cheap"    "$BIG"                                                     agy cheap bulk-ingest
assert_route "small-sum->std"    "Summarize this short paragraph please"                    agy standard grounded-research

echo "── Routing: sonnet (judgment / unclassified) ──────────"
assert_route "refactor->sonnet"  "Refactor the existing payment module to reduce dup"       native sonnet judgment-coding
assert_route "bugfix->sonnet"    "Fix the bug causing login to crash on empty input"        native sonnet judgment-coding
assert_route "unknown->sonnet"   "Please take care of the thing from yesterday"             native sonnet catch-all-safe

echo "── Routing: regression (review findings) ──────────────"
# Judgment work that also trips a commodity noun must stay on Sonnet, not leak to agy.
assert_route "bugfix+ui->sonnet"   "Fix the bug where the login button does nothing on mobile" native sonnet judgment-coding
assert_route "bugfix+script->sonnet" "Fix the bug in our deployment script"                    native sonnet judgment-coding
assert_route "refactor+extract->sonnet" "Refactor the user service to extract a validation helper" native sonnet judgment-coding
assert_route "refactor+ingest->sonnet"  "Read through the codebase and refactor the auth module"   native sonnet judgment-coding
# OPUS hard-line regexes must NOT false-positive on everyday terms.
assert_eq "react-hooks !opus"      "$(field "$("$ROUTE" 'Refactor the component to use hooks' 2>/dev/null)" tier)" sonnet
assert_eq "DI !opus"               "$(field "$("$ROUTE" 'Set up dependency injection in the Spring controller' 2>/dev/null)" tier)" sonnet
assert_eq "SQLi-prevent !opus"     "$(field "$("$ROUTE" 'Add input sanitization to prevent SQL injection' 2>/dev/null)" tier)" sonnet
assert_eq "binary-search !opus"    "$(field "$("$ROUTE" 'Implement binary search over the sorted array' 2>/dev/null)" tier)" sonnet
assert_eq "config-logic !agy"      "$(field "$("$ROUTE" 'Update the config file parsing logic to handle nested keys' 2>/dev/null)" backend)" native
# Real RE/injection signals must STILL route to Opus (no regression in coverage).
assert_route "real-hook->opus"     "Hook the render function with a detour trampoline"        native opus re-injection-heavy
assert_route "real-inject->opus"   "Inject a payload into the target process memory"          native opus re-injection-heavy
assert_route "real-binary->opus"   "Reverse engineer the binary and dump the exe"             native opus re-injection-heavy

echo "── Routing: presets ───────────────────────────────────"
assert_eq "budget: refactor->agy" "$(field "$("$ROUTE" --preset budget 'Refactor the existing module' 2>/dev/null)" backend)" agy
assert_eq "premium: react->native" "$(field "$("$ROUTE" --preset premium 'Create a new React component' 2>/dev/null)" backend)" native

echo "── Unit: quota detection ──────────────────────────────"
( . "$MMT_ROOT/scripts/lib/backends.sh"
  eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$MMT_ROOT/config/roster.json" backend-env agy)"
  mmt_quota_exhausted "all good" "" 0 && echo Q_CLEAN_BAD || echo Q_CLEAN_OK
  mmt_quota_exhausted "RESOURCE_EXHAUSTED quota exceeded" "" 1 && echo Q_QUOTA_OK || echo Q_QUOTA_BAD
  mmt_quota_exhausted "" "429 Too Many Requests" 1 && echo Q_429_OK || echo Q_429_BAD
) > /tmp/q.out 2>/dev/null
assert_contains "quota: clean not flagged" "$(cat /tmp/q.out)" Q_CLEAN_OK
assert_contains "quota: RESOURCE_EXHAUSTED" "$(cat /tmp/q.out)" Q_QUOTA_OK
assert_contains "quota: 429"                "$(cat /tmp/q.out)" Q_429_OK

echo "── Unit: clean() strips CR + winpty noise ─────────────"
CLEANED="$( . "$MMT_ROOT/scripts/lib/backends.sh"; printf 'HELLO\r\nAssertion failed: ... winpty.cc, line 924\n' | mmt_clean )"
assert_eq "clean: no winpty noise" "$CLEANED" "HELLO"

echo "── Unit: state start/end writes counters ──────────────"
TMPSTATE="$(mktemp -d)"
( unset MMT_STATE_FILE; export MMT_STATE_DIR="$TMPSTATE"
  . "$MMT_ROOT/scripts/lib/state.sh"
  mmt_state_init
  mmt_state_start id1 agy "Gemini 3.1 Pro (Low)" standard-coding 100
  mmt_state_end   id1 agy "Gemini 3.1 Pro (Low)" standard-coding 0 1234 50 0
)
ST="$TMPSTATE/state.json"
# Pipe the file via stdin (cat understands msys paths; an embedded path in a python
# -c string would skip MSYS2's arg path-conversion and native python can't open it).
sget() { cat "$ST" 2>/dev/null | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }
assert_eq "state: calls=1"      "$(sget calls)" 1
assert_eq "state: last_backend" "$(sget last_backend)" agy
assert_eq "state: open=0"       "$(sget open)" 0
rm -rf "$TMPSTATE"

echo "── Unit: statusline rendering ─────────────────────────"
SL="$MMT_ROOT/statusline/statusline.sh"
# state.json is always one-field-per-line (see state.sh); fixtures match that format.
cat > /tmp/sl_active.json <<'EOF'
{
  "open": 2,
  "calls": 5,
  "active_backend": "agy",
  "active_model": "Gemini 3.1 Pro (Low)",
  "approx_out_chars": 12300
}
EOF
cat > /tmp/sl_idle.json <<'EOF'
{
  "open": 0,
  "calls": 3,
  "fallbacks": 1,
  "last_backend": "agy",
  "last_code": 0,
  "last_dur_ms": 3400
}
EOF
assert_contains "statusline: active" "$(MMT_STATE_FILE=/tmp/sl_active.json bash "$SL" </dev/null)" "2 open"
assert_contains "statusline: idle"   "$(MMT_STATE_FILE=/tmp/sl_idle.json bash "$SL" </dev/null)" "3 calls"
assert_contains "statusline: empty"  "$(MMT_STATE_FILE=/tmp/none.json bash "$SL" </dev/null)" "mmt idle"

echo "── Unit: heavy-read hook (allow/deny) ─────────────────"
HOOK="$MMT_ROOT/scripts/hooks/heavy-read-guard.sh"
head -c 1000  /dev/zero | tr '\0' x > /tmp/t_small.dump
head -c 80000 /dev/zero | tr '\0' x > /tmp/t_big.dump
head -c 80000 /dev/zero | tr '\0' x > /tmp/t_big.txt
payload(){ printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$1"; }
assert_eq "hook: small dump -> allow" "$(payload /tmp/t_small.dump | bash "$HOOK")" ""
assert_eq "hook: big txt -> allow"    "$(payload /tmp/t_big.txt   | bash "$HOOK")" ""
assert_contains "hook: big dump -> deny" "$(payload /tmp/t_big.dump | bash "$HOOK")" '"permissionDecision":"deny"'

echo "── Unit: team cap-spec parser ─────────────────────────"
SPEC="$MMT_ROOT/scripts/lib/team_spec.py"
sf(){ "$PY" "$SPEC" "$1" 2>/dev/null | "$PY" -c "import sys,json;print(json.load(sys.stdin)['$2'])"; }
assert_eq "spec: 5:gemini,2:claude gemini" "$(sf '5:gemini,2:claude' gemini)" 5
assert_eq "spec: 5:gemini,2:claude claude" "$(sf '5:gemini,2:claude' claude)" 2
assert_eq "spec: order-agnostic"           "$(sf 'gemini:3,claude:1' gemini)" 3
assert_eq "spec: synonyms agy/native"      "$(sf '3:agy,2:native' claude)" 2
assert_eq "spec: empty -> default source"  "$(sf '' source)" default
assert_eq "spec: garbage -> default"       "$(sf 'garbage:xyz' source)" default
assert_eq "spec: clamp 99 -> 16"           "$(sf '99:gemini' gemini)" 16

echo "── Unit: team plan -> manifest ────────────────────────"
PLAND="$(mktemp -d)"
cat > "$PLAND/plan.json" <<'EOF'
[
  {"label":"a","task":"do A","backend":"agy","tier":"standard"},
  {"label":"b","task":"do B","backend":"native","tier":"sonnet"},
  {"label":"c","task":"  ","backend":"agy","tier":"cheap"}
]
EOF
MAN="$("$PY" "$MMT_ROOT/scripts/lib/team_plan.py" "$PLAND/plan.json" "$PLAND/w" 2>/dev/null)"
assert_contains "plan: agy line"    "$MAN" "AGY"$'\t'"0"$'\t'"a"
assert_contains "plan: native line" "$MAN" "NATIVE"$'\t'"1"$'\t'"b"
assert_eq "plan: empty task skipped" "$(printf '%s\n' "$MAN" | grep -c .)" 2
assert_eq "plan: task file written"  "$(cat "$PLAND/w/0.task" 2>/dev/null)" "do A"
# codex is a first-class CLI backend in the non-Ultracode path too (not coerced to native).
printf '%s' '[{"label":"v","task":"review the diff","backend":"codex","tier":"standard"}]' > "$PLAND/codex.json"
MANC="$("$PY" "$MMT_ROOT/scripts/lib/team_plan.py" "$PLAND/codex.json" "$PLAND/wc" 2>/dev/null)"
assert_contains "plan: codex line (not native)" "$MANC" "CODEX"$'\t'"0"$'\t'"v"$'\t'"standard"
rm -rf "$PLAND"

echo "── Unit: team --split (deterministic boundary) ────────"
sps(){ "$PY" "$SPEC" --split "$1" 2>/dev/null | "$PY" -c "import sys,json;print(json.load(sys.stdin)['$2'])"; }
assert_eq "split: caps preserved either order" "$(sps '2:claude,5:gemini build it' gemini)" 5
assert_eq "split: task extracted"              "$(sps '5:gemini,2:claude build it' task)" "build it"
assert_eq "split: 'N steps:' not a spec"       "$(sps 'do a thing with 3 steps: x' task)" "do a thing with 3 steps: x"
assert_eq "split: no spec -> default gemini"   "$(sps 'fix the bug' gemini)" 4

echo "── Unit: team_plan tier allowlist (TSV-injection) ─────"
PLANI="$(mktemp -d)"
printf '%s' '[{"label":"a","task":"benign","backend":"native","tier":"sonnet\nAGY\t../../etc\tpwned\tstandard"}]' > "$PLANI/p.json"
MANI="$("$PY" "$MMT_ROOT/scripts/lib/team_plan.py" "$PLANI/p.json" "$PLANI/w" 2>/dev/null)"
assert_eq "plan: forged row neutralized (1 line)" "$(printf '%s\n' "$MANI" | grep -c .)" 1
assert_contains "plan: tier coerced to allowlist" "$MANI" "NATIVE"$'\t'"0"$'\t'"a"$'\t'"sonnet"$'\t'
rm -rf "$PLANI"

echo "── Unit: team_plan tolerates deps/verify keys ─────────"
# The v0.3 plan schema adds deps + verify; team_plan.py must ignore them (inert) and still
# emit the same manifest, so the script path tolerates the richer plan without change.
PLAND2="$(mktemp -d)"
cat > "$PLAND2/plan.json" <<'EOF'
[
  {"label":"m","task":"design model","backend":"native","tier":"sonnet","deps":[],"verify":"has schema"},
  {"label":"s","task":"write sql","backend":"agy","tier":"standard","deps":["m"],"verify":"valid sql"}
]
EOF
MAN2="$("$PY" "$MMT_ROOT/scripts/lib/team_plan.py" "$PLAND2/plan.json" "$PLAND2/w" 2>/dev/null)"
assert_contains "plan(deps): native line" "$MAN2" "NATIVE"$'\t'"0"$'\t'"m"$'\t'"sonnet"
assert_contains "plan(deps): agy line"    "$MAN2" "AGY"$'\t'"1"$'\t'"s"$'\t'"standard"
assert_eq "plan(deps): 2 lines"           "$(printf '%s\n' "$MAN2" | grep -c .)" 2
rm -rf "$PLAND2"

echo "── Unit: team.mjs determinism + pipeline structure ────"
MJS="$MMT_ROOT/workflows/team.mjs"
# The Workflow runtime forbids Date/random APIs (they break resume) — even the literal
# tokens trip its determinism guard. Assert none appear anywhere in the script.
if grep -Eq 'Date\.now|Math\.random|new Date' "$MJS"; then
  bad "team.mjs: no Date/random APIs" "found a forbidden token"
else
  ok "team.mjs: no Date/random APIs"
fi
# Structure: the staged pipeline + verify/fix machinery are present. Verify/Fix are tagged on
# agents (interleaved per subtask), so they appear as `phase: '...'` opts, not phase() calls.
for marker in "phase('Decompose')" "phase('Dispatch')" "phase('Synthesize')" "phase: 'Verify'" "runSubtask" "verifyResult" "MAX_FIX" "#fix" "team-verify" "codexVerify" "teamConfig" "dispatchRelay" "backendLabel" "tierModel" ":verify:" "byBackend" "DISPATCH" "backend_ran" "ranOn" "parseVerdict" "PURE RELAY PIPE" "native-fallback"; do
  if grep -qF "$marker" "$MJS"; then ok "team.mjs has: $marker"; else bad "team.mjs missing: $marker"; fi
done

echo "── Unit: team.mjs stub harness (equal backends, any role) ───────"
# Run the pipeline against stubbed Workflow globals with a 3-backend plan (native+agy+codex) under
# several role configs, to prove backends are EQUAL: codex is a real dispatch target (not verify-only)
# and any backend (codex / agy / native) can be the verifier. No live model.
if command -v node >/dev/null 2>&1; then
  H1="$(node "$MMT_ROOT/tests/team_mjs_harness.mjs" "$MJS" 2>&1)"
  assert_contains "harness: default pipeline ok"                        "$H1" HARNESS_OK
  assert_contains "harness: codex is a dispatch backend (not verify-only)" "$H1" "codexDispatch=ok"
  assert_contains "harness: default verifier=codex"                     "$H1" "verifier=codex"
  H2="$(node "$MMT_ROOT/tests/team_mjs_harness.mjs" "$MJS" '{"verifier":"agy"}' 2>&1)"
  assert_contains "harness: agy can be the verifier"                    "$H2" "verifier=agy"
  H3="$(node "$MMT_ROOT/tests/team_mjs_harness.mjs" "$MJS" '{"verifier":"native"}' 2>&1)"
  assert_contains "harness: native can be the verifier"                 "$H3" "verifier=native"
  H4="$(node "$MMT_ROOT/tests/team_mjs_harness.mjs" "$MJS" '{"dispatch_backends":["agy","native"]}' 2>&1)"
  assert_contains "harness: dispatch set is restrictable"               "$H4" "backends=agy+native"
  # CLI-down regression: when the CLI backends are unavailable, the relay must NOT silently answer in
  # Claude under a gemini:/codex: label — each CLI subtask falls back to a VISIBLE native: agent.
  H5="$(MMT_HARNESS_CLI_DOWN=1 node "$MMT_ROOT/tests/team_mjs_harness.mjs" "$MJS" 2>&1)"
  assert_contains "harness: CLI-down -> visible native fallback (no dress-up)" "$H5" "HARNESS_OK_FALLBACK"
else
  ok "team.mjs harness: skipped (node not found)"
fi

echo "── Unit: proactive hook (UserPromptSubmit) ────────────"
PHOOK="$MMT_ROOT/scripts/hooks/proactive-route.sh"
PTMP="$(mktemp -d)"
# Temp rosters (JSON): same routing rules, proactive flipped on (and one with a tiny size cap).
# Built via python (argv path + bash redirect, ensure_ascii) to dodge the msys-path gotcha.
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['proactive']['enabled']=True; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$PTMP/on.json"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['proactive']['enabled']=True; d['proactive']['max_chars']=10; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$PTMP/cap.json"
hookrun() { printf '%s' "$1" | MMT_ROSTER="$2" bash "$PHOOK" 2>/dev/null; }   # payload roster
SQLP='{"prompt":"Write a SQL query to join users and orders tables"}'

assert_eq       "proactive: disabled -> silent"        "$(hookrun "$SQLP" "$MMT_ROOT/config/roster.json")" ""
assert_contains "proactive: enabled+agy -> nudge"      "$(hookrun "$SQLP" "$PTMP/on.json")" "routes to agy"
assert_contains "proactive: nudge names delegate"      "$(hookrun "$SQLP" "$PTMP/on.json")" "multi-model-team:delegate"
assert_eq       "proactive: opus task -> silent"       "$(hookrun '{"prompt":"Reverse engineer the IL2CPP dump and extract protobuf"}' "$PTMP/on.json")" ""
assert_eq       "proactive: slash command -> silent"   "$(hookrun '{"prompt":"/team build a thing"}' "$PTMP/on.json")" ""
assert_eq       "proactive: max_chars cap -> silent"   "$(hookrun "$SQLP" "$PTMP/cap.json")" ""
assert_eq       "proactive: env DISABLE -> silent"     "$(printf '%s' "$SQLP" | MMT_PROACTIVE_DISABLE=1 MMT_ROSTER="$PTMP/on.json" bash "$PHOOK" 2>/dev/null)" ""
rm -rf "$PTMP"

echo "── Unit: spawn-route guard (PreToolUse Task/Agent) ────"
SHOOK="$MMT_ROOT/scripts/hooks/spawn-route-guard.sh"
assert_contains "hooks.json: registers spawn guard" "$(cat "$MMT_ROOT/hooks/hooks.json")" "spawn-route-guard.sh"
assert_contains "hooks.json: matches Task|Agent"    "$(cat "$MMT_ROOT/hooks/hooks.json")" "Task|Agent"
STMP="$(mktemp -d)"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['proactive']['enabled']=True; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$STMP/on.json"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['proactive']['enabled']=True; d['proactive']['enforce_spawns']=True; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$STMP/enforce.json"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['proactive']['enabled']=True; d['proactive']['guard_spawns']=False; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$STMP/guardoff.json"
# Build a PreToolUse Task payload (argv -> json, msys-safe) and run the guard with a chosen roster.
mkspawn() { "$PY" -c 'import json,sys; print(json.dumps({"tool_name":"Task","tool_input":{"subagent_type":sys.argv[1],"description":sys.argv[2],"prompt":sys.argv[3]}}))' "$1" "$2" "$3"; }
shook() { printf '%s' "$1" | MMT_ROSTER="$2" bash "$SHOOK" 2>/dev/null; }
SQLSPAWN="$(mkspawn general-purpose 'write sql' 'Write a SQL query to list all users sorted by signup date')"
CODEXSPAWN="$(mkspawn general-purpose 'review' 'Review this diff for correctness bugs and regressions, then write a regression test suite')"
NATSPAWN="$(mkspawn general-purpose 're' 'Reverse engineer the IL2CPP global-metadata and reconstruct protobuf schemas via disassembly')"
OURSPAWN="$(mkspawn multi-model-team:delegate 'x' 'Write a SQL query to list all users')"
RUNSPAWN="$(mkspawn general-purpose 'x' 'bash run.sh --decision to dispatch this subtask')"
WORKERSPAWN="$(mkspawn general-purpose 'x' '[mmt-team-worker] Write a SQL query to list all users')"

assert_eq       "spawn: disabled -> silent"            "$(shook "$SQLSPAWN"   "$MMT_ROOT/config/roster.json")" ""
assert_contains "spawn: agy task -> allow nudge"       "$(shook "$SQLSPAWN"   "$STMP/on.json")"      '"permissionDecision":"allow"'
assert_contains "spawn: agy nudge names agy"           "$(shook "$SQLSPAWN"   "$STMP/on.json")"      "routes to agy"
assert_contains "spawn: agy nudge names delegate"      "$(shook "$SQLSPAWN"   "$STMP/on.json")"      "multi-model-team:delegate"
assert_contains "spawn: enforce -> deny"               "$(shook "$SQLSPAWN"   "$STMP/enforce.json")" '"permissionDecision":"deny"'
assert_contains "spawn: codex task -> nudge codex"     "$(shook "$CODEXSPAWN" "$STMP/on.json")"      "routes to codex"
assert_contains "spawn: codex nudge names codex agent" "$(shook "$CODEXSPAWN" "$STMP/on.json")"      "multi-model-team:codex"
assert_eq       "spawn: native task -> silent"         "$(shook "$NATSPAWN"   "$STMP/on.json")"      ""
assert_eq       "spawn: our subagent -> silent"        "$(shook "$OURSPAWN"   "$STMP/on.json")"      ""
assert_eq       "spawn: already-dispatching -> silent" "$(shook "$RUNSPAWN"   "$STMP/on.json")"      ""
assert_eq       "spawn: team-worker tag -> silent"     "$(shook "$WORKERSPAWN" "$STMP/on.json")"     ""
assert_eq       "spawn: guard_spawns=false -> silent"  "$(shook "$SQLSPAWN"   "$STMP/guardoff.json")" ""
assert_eq       "spawn: env DISABLE -> silent"         "$(printf '%s' "$SQLSPAWN" | MMT_PROACTIVE_DISABLE=1 MMT_ROSTER="$STMP/on.json" bash "$SHOOK" 2>/dev/null)" ""
# OMC-aware: an oh-my-claudecode TEAM worker (team_name set / oh-my-claudecode:* / OMC preamble) is
# NUDGED toward run.sh but NEVER denied — even under enforce_spawns — so we can't break OMC's
# teammate orchestration. (A plain worker under enforce DOES deny — asserted above.)
assert_contains "spawn-guard: OMC-aware code"            "$(cat "$SHOOK")" "is_omc"
OMCSPAWN="$("$PY" -c 'import json; print(json.dumps({"tool_name":"Task","tool_input":{"subagent_type":"oh-my-claudecode:executor","team_name":"fix-ts","name":"worker-1","description":"write sql","prompt":"You are a TEAM WORKER in team fix-ts. You report to team-lead. Write a SQL query to list all users sorted by signup date."}}))')"
assert_contains "spawn: OMC worker -> allow nudge"        "$(shook "$OMCSPAWN" "$STMP/on.json")"      '"permissionDecision":"allow"'
assert_contains "spawn: OMC nudge points at run.sh"       "$(shook "$OMCSPAWN" "$STMP/on.json")"      "run.sh"
assert_contains "spawn: OMC worker under enforce -> allow" "$(shook "$OMCSPAWN" "$STMP/enforce.json")" '"permissionDecision":"allow"'
rm -rf "$STMP"

echo "── Unit: proactive-env (spawn-guard knobs) ────────────"
PE_DEF="$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$MMT_ROOT/config/roster.json" proactive-env 2>/dev/null)"
assert_contains "proactive-env: guard_spawns default 1"    "$PE_DEF" "MMT_PROACTIVE_GUARD_SPAWNS=1"
assert_contains "proactive-env: enforce_spawns default 0"  "$PE_DEF" "MMT_PROACTIVE_ENFORCE_SPAWNS=0"
PETMP="$(mktemp -d)"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['proactive']['guard_spawns']=False; d['proactive']['enforce_spawns']=True; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$PETMP/p.json"
PE_OV="$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$PETMP/p.json" proactive-env 2>/dev/null)"
assert_contains "proactive-env: guard_spawns override 0"   "$PE_OV" "MMT_PROACTIVE_GUARD_SPAWNS=0"
assert_contains "proactive-env: enforce_spawns override 1" "$PE_OV" "MMT_PROACTIVE_ENFORCE_SPAWNS=1"
rm -rf "$PETMP"

echo "── Unit: explicit force overrides the hard-line ───────"
# An EXPLICIT backend choice (forced agent / forced --decision / team assignment) must be HONORED,
# not bounced to native by the OPUS hard line. Auto-routing keeps the hard line as its default.
RE_TASK='Reverse engineer the IL2CPP dump and reconstruct the protobuf schemas via disassembly'
assert_contains "force: auto-route still hard-lines RE" \
  "$(printf '%s' "$RE_TASK" | bash "$MMT_ROOT/scripts/route.sh" 2>/dev/null)" 're-injection-heavy'
# Forced decision bypasses route.sh entirely. Offline-safe: disable the CLIs so it falls through to a
# native handoff whose rule is the FORCED rule (delegate-forced), never the auto-route re-injection-heavy.
FTMP="$(mktemp -d)"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['backends']['agy']['enabled']=False; d['backends']['codex']['enabled']=False; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$FTMP/nocli.json"
FORCED_OUT="$(MMT_ROSTER="$FTMP/nocli.json" bash "$RUN" --decision '{"backend":"agy","model":"","tier":"standard","rule":"delegate-forced","native":false}' "$RE_TASK" 2>/dev/null)"
assert_eq       "force: forced decision bypasses hard-line" "$(printf '%s' "$FORCED_OUT" | grep -c 're-injection-heavy')" "0"
assert_contains "force: forced rule survives to handoff"    "$FORCED_OUT" "delegate-forced"
rm -rf "$FTMP"
# The shipped forced agents carry the explicit-choice body and no longer self-reject RE.
assert_contains "force: delegate.md forces backend"   "$(cat "$MMT_ROOT/agents/delegate.md")" '"native":false'
assert_contains "force: delegate.md honors explicit"  "$(cat "$MMT_ROOT/agents/delegate.md")" "explicit choice"
assert_contains "force: codex.md honors explicit"     "$(cat "$MMT_ROOT/agents/codex.md")"    "explicit choice"
assert_eq       "force: no agent self-rejects RE"     "$(grep -l 'Never reverse-engineer' "$MMT_ROOT"/agents/*.md 2>/dev/null | wc -l | tr -d ' ')" "0"

echo "── Unit: backend failure surfaces stderr ─────────────"
# A failing backend (e.g. codex hitting a sandbox/timeout) must NOT vanish into a silent empty
# result — run.sh announces the failure + exit code + the captured stderr, and carries it into the
# native-handoff. Deterministic + offline: a fake CLI passes health (--version) then fails `exec`.
EFTMP="$(mktemp -d)"
FAKE="$EFTMP/fakecodex.sh"
cat > "$FAKE" <<'FAKEEOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "fakecodex 9.9" ;;                                   # health passes
  *) echo "FAKE_SANDBOX_DENIED sandbox read-only refused" >&2; exit 1 ;;  # invoke fails w/ stderr
esac
FAKEEOF
chmod +x "$FAKE"
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['backends']['agy']['enabled']=False; d['defaults']['quota_fallback']=['codex','native:sonnet']; print(json.dumps(d))" "$MMT_ROOT/config/roster.json" > "$EFTMP/r.json"
EF_OUT="$(MMT_BE_BIN="$FAKE" MMT_ROSTER="$EFTMP/r.json" bash "$RUN" --decision '{"backend":"codex","model":"","tier":"standard","rule":"team-verify","native":false}' "review this" 2>&1)"
assert_contains "fail: run.sh announces backend failure" "$EF_OUT" "returned no usable output (exit 1)"
assert_contains "fail: backend stderr is surfaced"       "$EF_OUT" "FAKE_SANDBOX_DENIED"
assert_contains "fail: handoff carries last error"       "$EF_OUT" "last error:"
rm -rf "$EFTMP"

echo "── Unit: JSON config — backends configurable ──────────"
CJSON="$MMT_ROOT/config/roster.json"
CFG() { "$PY" "$MMT_ROOT/scripts/lib/config.py" "$CJSON" backend-env "$1" 2>/dev/null; }
assert_contains "backend: agy kind gemini"    "$(CFG agy)"      "MMT_BE_KIND=gemini"
assert_contains "backend: codex enabled"      "$(CFG codex)"    "MMT_BE_ENABLED=1"
assert_contains "backend: codex kind codex"   "$(CFG codex)"    "MMT_BE_KIND=codex"
assert_contains "backend: codex oneshot exec" "$(CFG codex)"    "MMT_BE_ONESHOT=exec"
assert_contains "backend: opencode disabled"  "$(CFG opencode)" "MMT_BE_ENABLED=0"
assert_contains "backend: unknown -> off"     "$(CFG nope)"     "MMT_BE_ENABLED=0"
RTMP="$(mktemp -d)"
# Disabling backends makes run.sh skip them -> native handoff (offline: no backend called).
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['backends']['agy']['enabled']=False; d['backends']['codex']['enabled']=False; print(json.dumps(d))" "$CJSON" > "$RTMP/off.json"
assert_contains "backend: all disabled -> native handoff" \
  "$(MMT_ROSTER="$RTMP/off.json" bash "$RUN" "Write a SQL query to list users" 2>/dev/null)" "MMT_NATIVE_HANDOFF"
# A kind with no invoker (opencode) health-fails -> skipped -> native (offline).
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['backends']['agy']['enabled']=False; d['backends']['codex']['enabled']=False; d['backends']['opencode']['enabled']=True; d['defaults']['quota_fallback']=['agy','opencode','native:sonnet']; print(json.dumps(d))" "$CJSON" > "$RTMP/oc.json"
assert_contains "backend: no-invoker kind -> native handoff" \
  "$(MMT_ROSTER="$RTMP/oc.json" bash "$RUN" "Write a SQL query to list users" 2>/dev/null)" "MMT_NATIVE_HANDOFF"
rm -rf "$RTMP"

echo "── Unit: team config (equal, configurable roles) ──────"
TC_DEF="$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$CJSON" team-config 2>&1)"
assert_contains "team-config: default dispatch_backends" "$TC_DEF" '"dispatch_backends": ["agy", "codex", "native"]'
assert_contains "team-config: default verifier codex"    "$TC_DEF" '"verifier": "codex"'
assert_contains "team-config: default cap agy 4"         "$TC_DEF" '"agy": 4'
assert_contains "team-config: default cap codex 2"       "$TC_DEF" '"codex": 2'
TTMP="$(mktemp -d)"
# Swap the roles (agy verifies, dispatch set excludes agy) + remap a tier; config.py merges caps.
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d.setdefault('team',{}); d['team']['verifier']='agy'; d['team']['dispatch_backends']=['codex','native']; d['team'].setdefault('caps',{})['codex']=6; d['team'].setdefault('tier_models',{})['standard']='haiku'; print(json.dumps(d))" "$CJSON" > "$TTMP/team.json"
TC_OV="$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$TTMP/team.json" team-config 2>&1)"
assert_contains "team-config: override verifier agy"        "$TC_OV" '"verifier": "agy"'
assert_contains "team-config: override dispatch set"        "$TC_OV" '"dispatch_backends": ["codex", "native"]'
assert_contains "team-config: override cap codex 6"         "$TC_OV" '"codex": 6'
assert_contains "team-config: merge keeps cap native 2"     "$TC_OV" '"native": 2'
assert_contains "team-config: override tier standard haiku" "$TC_OV" '"standard": "haiku"'
rm -rf "$TTMP"

echo "── Unit: gen_agents.py (enable/disable -> .md) ────────"
GTMP="$(mktemp -d)"; mkdir -p "$GTMP/agents"
printf 'stale' > "$GTMP/agents/bulk-summarizer.md"      # should be removed (disabled below)
"$PY" -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); d['agents']['bulk-summarizer']['enabled']=False; print(json.dumps(d))" "$CJSON" > "$GTMP/r.json"
"$PY" "$MMT_ROOT/scripts/lib/gen_agents.py" "$GTMP/r.json" "$GTMP/agents" >/dev/null 2>&1
assert_eq       "gen: enabled agent written"  "$( [ -f "$GTMP/agents/delegate.md" ] && echo yes || echo no )" yes
assert_eq       "gen: disabled agent removed" "$( [ -f "$GTMP/agents/bulk-summarizer.md" ] && echo yes || echo no )" no
assert_contains "gen: relay body present"     "$(cat "$GTMP/agents/delegate.md" 2>/dev/null)" "scripts/run.sh"
rm -rf "$GTMP"

# ---- live agy smoke tests (opt-in) ----------------------------------------
if [ "${MMT_LIVE:-0}" = "1" ]; then
  echo "── LIVE: agy smoke tests ──────────────────────────────"
  ( . "$MMT_ROOT/scripts/lib/common.sh"; . "$MMT_ROOT/scripts/lib/backends.sh"
    eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$MMT_ROOT/config/roster.json" backend-env agy)"
    mmt_be_health && echo LIVE_HEALTH_OK || echo LIVE_HEALTH_BAD
  ) > /tmp/live_h.out 2>/dev/null
  assert_contains "live: health" "$(cat /tmp/live_h.out)" LIVE_HEALTH_OK

  STD_OUT="$(bash "$RUN" "Write a SQL query selecting all columns from the users table. Output only the SQL." 2>/dev/null)"
  case "$STD_OUT" in
    MMT_NATIVE_HANDOFF*) bad "live: standard agy returns result" "got native handoff: $STD_OUT" ;;
    "") bad "live: standard agy returns result" "empty output" ;;
    *) ok "live: standard agy returns result" ;;
  esac
  assert_contains "live: result looks like SQL" "$(printf '%s' "$STD_OUT" | tr a-z A-Z)" SELECT

  CHP_OUT="$(bash "$RUN" --decision '{"backend":"agy","model":"","tier":"cheap","rule":"bulk-forced","native":false}' "Reply with exactly the single word: CHEAPOK" 2>/dev/null)"
  assert_contains "live: cheap tier responds" "$(printf '%s' "$CHP_OUT" | tr a-z A-Z)" CHEAPOK

  if command -v codex >/dev/null 2>&1; then
    CX_OUT="$(bash "$RUN" --decision '{"backend":"codex","model":"","tier":"standard","rule":"codex-smoke","native":false}' "Reply with exactly the single word: CODEXOK" 2>/dev/null)"
    assert_contains "live: codex backend responds" "$(printf '%s' "$CX_OUT" | tr a-z A-Z)" CODEXOK
  else
    ok "live: codex backend (skipped, codex not on PATH)"
  fi

  echo "── LIVE: team.sh parallel fan-out ─────────────────────"
  TPLAN="$(mktemp -d)"
  cat > "$TPLAN/plan.json" <<'EOF'
[
  {"label":"sql","task":"Write a Postgres SQL query that counts rows in the orders table. Output only the SQL.","backend":"agy","tier":"standard"},
  {"label":"re","task":"Write a regex matching a hex color like #1a2b3c. Output only the regex.","backend":"agy","tier":"cheap"},
  {"label":"review","task":"In one sentence, what makes a SQL COUNT(*) query correct?","backend":"codex","tier":"standard"},
  {"label":"judge","task":"Decide if we should shard the database.","backend":"native","tier":"sonnet"}
]
EOF
  TEAM_OUT="$(bash "$MMT_ROOT/scripts/team.sh" --plan "$TPLAN/plan.json" --gemini-cap 4 2>/dev/null)"
  assert_contains "live team: 3 cli dispatched"  "$TEAM_OUT" "3 cli"
  assert_contains "live team: sql result"        "$(printf '%s' "$TEAM_OUT" | tr a-z A-Z)" SELECT
  assert_contains "live team: codex is a dispatch backend" "$TEAM_OUT" "CODEX [review]"
  assert_contains "live team: native listed"     "$TEAM_OUT" "NATIVE [judge]"
  rm -rf "$TPLAN"
fi

echo
echo "════════════════════════════════════════════════════════"
echo "  PASSED: $PASS    FAILED: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '  failing: %s\n' "${FAILED_NAMES[*]}"
  exit 1
fi
echo "  ALL GREEN"
