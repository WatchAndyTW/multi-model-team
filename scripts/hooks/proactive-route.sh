#!/usr/bin/env bash
# proactive-route.sh — UserPromptSubmit hook for the multi-model-team plugin.
#
# When proactive.enabled is true in roster.json, every submitted prompt that the router
# would send to agy gets a one-shot reminder injected (as additionalContext), nudging Claude
# to DELEGATE it — spawn the multi-model-team:delegate agent (or run /team) — instead of
# solving it inline. The reminder ALWAYS fires when the conditions hold (deterministic);
# whether Claude takes the hint stays its judgment.
#
# OFF by default. Fails SILENT (no nudge) on any uncertainty, and bails in pure bash before
# spending a single python process when disabled — so it costs ~nothing for users who leave
# it off. Configure in [proactive] (enabled / max_chars / min_chars / rules). Hard override:
#   MMT_PROACTIVE_DISABLE=1   force off regardless of config
set -u

[ "${MMT_PROACTIVE_DISABLE:-0}" = "1" ] && exit 0

payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # scripts/hooks -> plugin root
ROSTER="${MMT_ROSTER:-$MMT_ROOT/config/roster.json}"
[ -f "$ROSTER" ] || exit 0

# --- fast pure-bash gate: is proactive.enabled = true? (no fork when off) ------------------
# Reads the whole file with $(<file) (a bash builtin — no fork) and substring-scans the value
# after "proactive" -> "enabled". Robust to compact (single-line) OR pretty JSON. Authoritative
# parse happens later via config.py — this is only a cheap "should we even start" check.
_proactive_enabled() {
  local f="$1" blob after
  [ -f "$f" ] || return 1
  blob="$(<"$f")"
  case "$blob" in *'"proactive"'*) : ;; *) return 1 ;; esac
  after="${blob#*\"proactive\"}"           # text after the proactive key
  case "$after" in *'"enabled"'*) : ;; *) return 1 ;; esac
  after="${after#*\"enabled\"}"            # text after the enabled key
  after="${after%%,*}"                     # value region: up to the next comma...
  after="${after%%\}*}"                    # ...or the closing brace
  case "$after" in *true*) return 0 ;; *) return 1 ;; esac
}
_proactive_enabled "$ROSTER" || exit 0

# --- now we can afford python -------------------------------------------------------------
. "$MMT_ROOT/scripts/lib/common.sh" 2>/dev/null || exit 0
PY="$(mmt_find_python || true)"
[ -n "$PY" ] || exit 0

# Authoritative config (enabled + bounds + rule allowlist).
eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$ROSTER" proactive-env 2>/dev/null)" || exit 0
[ "${MMT_PROACTIVE_ENABLED:-0}" = "1" ] || exit 0

# Extract the user's prompt (JSON .prompt). Fail silent on anything unexpected.
prompt="$(printf '%s' "$payload" | "$PY" -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
p = d.get("prompt", "")
if isinstance(p, str):
    sys.stdout.write(p)
' 2>/dev/null)"

# Skip empties and explicit slash commands (those already route themselves).
trimmed="${prompt#"${prompt%%[![:space:]]*}"}"
[ -n "$trimmed" ] || exit 0
case "$trimmed" in /*) exit 0 ;; esac

# Size window (chars). 0 disables a bound.
chars="$(printf '%s' "$prompt" | wc -m | tr -d ' ')"
maxc="${MMT_PROACTIVE_MAX_CHARS:-0}"; minc="${MMT_PROACTIVE_MIN_CHARS:-0}"
case "$maxc" in ''|*[!0-9]*) maxc=0 ;; esac
case "$minc" in ''|*[!0-9]*) minc=0 ;; esac
case "$chars" in ''|*[!0-9]*) exit 0 ;; esac
[ "$maxc" -gt 0 ] 2>/dev/null && [ "$chars" -gt "$maxc" ] 2>/dev/null && exit 0
[ "$minc" -gt 0 ] 2>/dev/null && [ "$chars" -lt "$minc" ] 2>/dev/null && exit 0

# Route it (pure decision, no model call). Feed via stdin — never as an arg (injection-safe).
decision="$(printf '%s' "$prompt" | bash "$MMT_ROOT/scripts/route.sh" 2>/dev/null)"
[ -n "$decision" ] || exit 0

# Parse backend + rule + tier.
eval "$(printf '%s' "$decision" | "$PY" -c '
import sys, json, shlex
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for k in ("backend", "rule", "tier"):
    print("D_%s=%s" % (k, shlex.quote(str(d.get(k, "")))))
' 2>/dev/null)" || exit 0

[ "${D_backend:-}" = "agy" ] || exit 0   # only nudge for agy-routable work

# Optional rule allowlist (CSV). Empty = any agy rule.
rules="${MMT_PROACTIVE_RULES:-}"
if [ -n "$rules" ]; then
  match=0
  IFS=',' read -ra _rl <<< "$rules"
  for r in "${_rl[@]}"; do
    r="${r//[[:space:]]/}"
    [ -n "$r" ] && [ "$r" = "${D_rule:-}" ] && { match=1; break; }
  done
  [ "$match" = "1" ] || exit 0
fi

# Inject the reminder as UserPromptSubmit additionalContext (built in one python pass; the
# text is static + the matched rule/tier — the prompt itself is never echoed back).
ctx="multi-model-team: this request routes to agy (Gemini) [rule=${D_rule:-?}, tier=${D_tier:-?}]. \
If it is a standalone, verifiable task, prefer delegating it — spawn the \`multi-model-team:delegate\` \
agent (or run \`/team\`) so it runs on agy and saves Claude tokens — instead of solving it inline. \
This is a configurable nudge, not a rule: ignore it if the task needs your in-context judgment, \
codebase awareness, or is part of a larger change you are already making."

MMT_CTX="$ctx" "$PY" -c '
import os, json
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": os.environ.get("MMT_CTX", ""),
}}, separators=(",", ":")))'
exit 0
