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
assert_route "tests->agy-std"    "Write unit tests for the parser with pytest"              agy standard standard-coding
assert_route "video->agy-mm"     "Watch this YouTube video and summarize the key points"    agy standard multimodal
assert_route "oneliner->agy-chp" "Write one line of bash to count files"                    agy cheap trivial

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
  eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$MMT_ROOT/config/roster.toml" agy-env)"
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

# ---- live agy smoke tests (opt-in) ----------------------------------------
if [ "${MMT_LIVE:-0}" = "1" ]; then
  echo "── LIVE: agy smoke tests ──────────────────────────────"
  ( . "$MMT_ROOT/scripts/lib/common.sh"; . "$MMT_ROOT/scripts/lib/backends.sh"
    eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$MMT_ROOT/config/roster.toml" agy-env)"
    mmt_agy_health && echo LIVE_HEALTH_OK || echo LIVE_HEALTH_BAD
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
fi

echo
echo "════════════════════════════════════════════════════════"
echo "  PASSED: $PASS    FAILED: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '  failing: %s\n' "${FAILED_NAMES[*]}"
  exit 1
fi
echo "  ALL GREEN"
