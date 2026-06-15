#!/usr/bin/env bash
# workflow-route-guard.sh — PreToolUse hook (matcher: Workflow) for the multi-model-team plugin.
#
# A dynamic Workflow runs its agent() fan-out in an ISOLATED runtime that PreToolUse hooks cannot
# reach — so we cannot redirect a workflow's internal CLI-able agents from a hook. What we CAN do is
# fire on the Workflow tool *invocation* (an ordinary main-loop tool call) and, if the workflow's
# task would route to a CLI backend (agy or codex), inject a one-shot NUDGE before it launches:
# prefer /team (workflows/team.mjs routes each subtask through run.sh), or have this workflow's agents
# shell out to run.sh themselves. Soft, pre-launch, NEVER blocks (a workflow is a deliberate choice).
#
# EXEMPT: our own already-routed workflow (workflows/team.mjs — name "mmt-team", a team.mjs scriptPath,
# or a script that already calls run.sh / dispatchRelay).
#
# VERIFICATION AID: when it fires it appends one line to $HOME/.cache/mmt/wf-guard.log, so you can
# confirm the "Workflow" matcher actually dispatches (launch any workflow, then check that file).
#
# OFF by default (gated by proactive.enabled + guard_spawns). Bails in pure bash when disabled.
# Fail-OPEN: any uncertainty exits 0 (the workflow proceeds). Hard override: MMT_PROACTIVE_DISABLE=1.
set -u

[ "${MMT_PROACTIVE_DISABLE:-0}" = "1" ] && exit 0
payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROSTER="${MMT_ROSTER:-$MMT_ROOT/config/roster.json}"
[ -f "$ROSTER" ] || exit 0

# --- fast pure-bash gate: proactive.enabled = true? (no fork when off) ----------------------
_proactive_enabled() {
  local f="$1" blob after
  [ -f "$f" ] || return 1
  blob="$(<"$f")"
  case "$blob" in *'"proactive"'*) : ;; *) return 1 ;; esac
  after="${blob#*\"proactive\"}"
  case "$after" in *'"enabled"'*) : ;; *) return 1 ;; esac
  after="${after#*\"enabled\"}"
  after="${after%%,*}"
  after="${after%%\}*}"
  case "$after" in *true*) return 0 ;; *) return 1 ;; esac
}
_proactive_enabled "$ROSTER" || exit 0

. "$MMT_ROOT/scripts/lib/common.sh" 2>/dev/null || exit 0
PY="$(mmt_find_python || true)"
[ -n "$PY" ] || exit 0
eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$ROSTER" proactive-env 2>/dev/null)" || exit 0
[ "${MMT_PROACTIVE_ENABLED:-0}" = "1" ] || exit 0
[ "${MMT_PROACTIVE_GUARD_SPAWNS:-1}" = "1" ] || exit 0

# --- inspect the Workflow call: must be the Workflow tool; pull args.task; skip our own workflow ----
eval "$(printf '%s' "$payload" | "$PY" -c '
import sys, json, shlex
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool = str(d.get("tool_name", "") or "")
ti = d.get("tool_input", {}) or {}
name = str(ti.get("name", "") or "")
sp = str(ti.get("scriptPath", "") or "")
script = ti.get("script", "") or ""
if not isinstance(script, str): script = ""
args = ti.get("args", {})
if isinstance(args, str):
    try: args = json.loads(args)
    except Exception: args = {}
if not isinstance(args, dict): args = {}
task = args.get("task", "") or ""
if not isinstance(task, str): task = ""
blob = name + "\n" + sp + "\n" + script
# Our own routed workflow (team.mjs) already dispatches via run.sh — leave it alone.
ours = ("team.mjs" in sp) or ("team.mjs" in script) or (name == "mmt-team") or ("mmt-team" in blob) \
       or ("scripts/run.sh" in script) or ("dispatchRelay" in script)
skip = 0
if tool != "Workflow":
    skip = 1
elif ours:
    skip = 1
elif not task.strip():       # no routable args.task to nudge on (cannot classify the work)
    skip = 1
print("MMT_SKIP=%s" % ("1" if skip else "0"))
print("MMT_WF_NAME=%s" % shlex.quote(name or "unnamed"))
print("MMT_TASK_CHARS=%s" % shlex.quote(str(len(task))))
' 2>/dev/null)" || exit 0

# Verification marker: record that the Workflow matcher reached us (only when not skipped pre-routing).
if [ "${MMT_SKIP:-1}" = "0" ]; then
  _mk="${HOME:-/tmp}/.cache/mmt"
  mkdir -p "$_mk" 2>/dev/null && printf 'workflow-route-guard fired: name=%s chars=%s\n' \
    "${MMT_WF_NAME:-?}" "${MMT_TASK_CHARS:-0}" >> "$_mk/wf-guard.log" 2>/dev/null
fi
[ "${MMT_SKIP:-1}" = "0" ] || exit 0

# Size window (chars) — reuse the prompt-nudge bounds. 0 disables a bound.
chars="${MMT_TASK_CHARS:-0}"
maxc="${MMT_PROACTIVE_MAX_CHARS:-0}"; minc="${MMT_PROACTIVE_MIN_CHARS:-0}"
case "$chars" in ''|*[!0-9]*) exit 0 ;; esac
case "$maxc" in ''|*[!0-9]*) maxc=0 ;; esac
case "$minc" in ''|*[!0-9]*) minc=0 ;; esac
[ "$maxc" -gt 0 ] 2>/dev/null && [ "$chars" -gt "$maxc" ] 2>/dev/null && exit 0
[ "$minc" -gt 0 ] 2>/dev/null && [ "$chars" -lt "$minc" ] 2>/dev/null && exit 0

# Route args.task (pure decision, no model call). Feed via stdin ONLY — never as a shell arg.
decision="$(printf '%s' "$payload" | "$PY" -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input", {}) or {}
args = ti.get("args", {})
if isinstance(args, str):
    try: args = json.loads(args)
    except Exception: args = {}
if not isinstance(args, dict): args = {}
t = args.get("task", "") or ""
sys.stdout.write(t if isinstance(t, str) else "")
' 2>/dev/null | bash "$MMT_ROOT/scripts/route.sh" 2>/dev/null)"
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

# Only nudge when the workflow task routes to a CLI backend. native is fine as-is.
case "${D_backend:-}" in
  agy|codex) : ;;
  *) exit 0 ;;
esac

# Optional rule allowlist (CSV). Empty = any agy/codex rule.
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

case "${D_backend}" in
  agy)   be_disp="agy (Gemini)" ;;
  codex) be_disp="codex (Codex)" ;;
  *)     be_disp="${D_backend}" ;;
esac

# Emit a non-blocking nudge. The task text is NEVER echoed — only our own routing (backend/rule/tier).
MMT_BE="$D_backend" MMT_BE_DISP="$be_disp" MMT_RULE="${D_rule:-?}" MMT_TIER="${D_tier:-?}" \
MMT_ROOT_ENV="$MMT_ROOT" "$PY" -c '
import os, json
be   = os.environ.get("MMT_BE", "")
disp = os.environ.get("MMT_BE_DISP", be)
rule = os.environ.get("MMT_RULE", "?")
tier = os.environ.get("MMT_TIER", "?")
root = os.environ.get("MMT_ROOT_ENV", "")
runsh = (root + "/scripts/run.sh") if root else "scripts/run.sh"
ctx = ("multi-model-team: this dynamic workflow has work that routes to %s [rule=%s, tier=%s] per the "
       "multi-model-team config. A workflow runs its agents in an isolated runtime our spawn-guard "
       "cannot reach, so to actually run this work on %s: prefer /team (workflows/team.mjs dispatches "
       "each subtask through run.sh to agy/codex/native), OR have this workflow EXECUTE its CLI-able "
       "subtasks by shelling to `bash %s \"<subtask>\"` (a relay agent that returns run.sh stdout) "
       "instead of solving them directly in Claude. Not blocking — ignore for hard / in-context work."
       % (disp, rule, tier, be, runsh))
out = {"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": ctx,
}}
print(json.dumps(out, separators=(",", ":")))'
exit 0
