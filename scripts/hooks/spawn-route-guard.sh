#!/usr/bin/env bash
# spawn-route-guard.sh — PreToolUse hook (matcher: Task|Agent) for the multi-model-team plugin.
#
# The "NOT /team" companion to the prompt nudge. When proactive.enabled AND proactive.guard_spawns
# are true in roster.json, every AGENT-SPAWNING tool call (Task/Agent) whose task the router would
# send to a CLI backend (agy or codex) is intercepted so the work actually runs on that CLI instead
# of inside a plain Claude sub-agent:
#   - enforce_spawns = false (default): inject a NON-BLOCKING nudge (permissionDecision=allow +
#     additionalContext) telling the spawn to dispatch via scripts/run.sh / the matching plugin agent.
#   - enforce_spawns = true: DENY the spawn (permissionDecision=deny) with the same instruction, so the
#     model must re-issue the work through the CLI dispatch.
# Firing is deterministic; in nudge mode compliance stays the model's call.
#
# EXEMPT (never touched): the plugin's own /team workers and subagents — relay workers carry
# `run.sh`/`--decision`, native workers are tagged `[mmt-team-worker]`, and our subagents have a
# `multi-model-team:` subagent_type. So this only governs agents you spawn OUTSIDE the team pipeline.
#
# OFF by default. Bails in pure bash before spending a python process when proactive is disabled, so
# it costs ~nothing per spawn until opted in. Fail-OPEN: any uncertainty exits 0 (tool proceeds).
# Hard override: MMT_PROACTIVE_DISABLE=1.
set -u

[ "${MMT_PROACTIVE_DISABLE:-0}" = "1" ] && exit 0

payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # scripts/hooks -> plugin root
ROSTER="${MMT_ROSTER:-$MMT_ROOT/config/roster.json}"
[ -f "$ROSTER" ] || exit 0

# --- fast pure-bash gate: is proactive.enabled = true? (no fork when off) ------------------
# Same cheap "should we even start" check as the prompt nudge: read the whole file with $(<file)
# (a bash builtin, no fork) and substring-scan the value after "proactive" -> "enabled".
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

# --- now we can afford python --------------------------------------------------------------
. "$MMT_ROOT/scripts/lib/common.sh" 2>/dev/null || exit 0
PY="$(mmt_find_python || true)"
[ -n "$PY" ] || exit 0

# Authoritative config (enabled + guard_spawns + enforce_spawns + bounds + rule allowlist).
eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$ROSTER" proactive-env 2>/dev/null)" || exit 0
[ "${MMT_PROACTIVE_ENABLED:-0}" = "1" ] || exit 0
[ "${MMT_PROACTIVE_GUARD_SPAWNS:-1}" = "1" ] || exit 0

# --- inspect the spawn: tool, subagent_type, the spawned task, size, and skip markers ------
# One python pass. Emits ONLY metadata (never the task text) so nothing untrusted reaches eval.
# MMT_SKIP=1 when this spawn must be left alone: not a Task/Agent call; one of our own subagents
# (multi-model-team:*); an empty task; or a task already wired to our dispatch (carries run.sh /
# --decision / MMT_NATIVE_HANDOFF, or the [mmt-team-worker] tag our /team workers are stamped with).
eval "$(printf '%s' "$payload" | "$PY" -c '
import sys, json, shlex
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool = str(d.get("tool_name", "") or "")
ti = d.get("tool_input", {}) or {}
sub = str(ti.get("subagent_type", "") or "")
prompt = ti.get("prompt", "") or ""
desc = ti.get("description", "") or ""
if not isinstance(prompt, str): prompt = ""
if not isinstance(desc, str): desc = ""
task = prompt if prompt.strip() else desc
blob = (prompt + "\n" + desc)
markers = ("run.sh", "--decision", "MMT_NATIVE_HANDOFF", "mmt-team-worker")
skip = 0
if tool not in ("Task", "Agent"):
    skip = 1
elif sub.startswith("multi-model-team:"):
    skip = 1
elif not task.strip():
    skip = 1
elif any(m in blob for m in markers):
    skip = 1
print("MMT_SKIP=%s" % ("1" if skip else "0"))
print("MMT_TASK_CHARS=%s" % shlex.quote(str(len(task))))
' 2>/dev/null)" || exit 0

[ "${MMT_SKIP:-1}" = "0" ] || exit 0

# Size window (chars) — reuse the prompt-nudge bounds. 0 disables a bound.
chars="${MMT_TASK_CHARS:-0}"
maxc="${MMT_PROACTIVE_MAX_CHARS:-0}"; minc="${MMT_PROACTIVE_MIN_CHARS:-0}"
case "$chars" in ''|*[!0-9]*) exit 0 ;; esac
case "$maxc" in ''|*[!0-9]*) maxc=0 ;; esac
case "$minc" in ''|*[!0-9]*) minc=0 ;; esac
[ "$maxc" -gt 0 ] 2>/dev/null && [ "$chars" -gt "$maxc" ] 2>/dev/null && exit 0
[ "$minc" -gt 0 ] 2>/dev/null && [ "$chars" -lt "$minc" ] 2>/dev/null && exit 0

# Route the spawned task (pure decision, no model call). Feed via stdin ONLY — the task text is
# piped straight from the payload into route.sh and never becomes a shell arg (injection-safe).
decision="$(printf '%s' "$payload" | "$PY" -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input", {}) or {}
p = ti.get("prompt", "") or ""
de = ti.get("description", "") or ""
if not isinstance(p, str): p = ""
if not isinstance(de, str): de = ""
sys.stdout.write(p if p.strip() else de)
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

# Only CLI backends (the ones with a local CLI dispatch). native stays a Claude agent — leave it.
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

# Human label + matching plugin agent for the chosen backend.
case "${D_backend}" in
  agy)   be_disp="agy (Gemini)";  be_agent="multi-model-team:delegate" ;;
  codex) be_disp="codex (Codex)"; be_agent="multi-model-team:codex" ;;
  *)     be_disp="${D_backend}";  be_agent="multi-model-team:delegate" ;;
esac

# Emit the verdict. The task text is NEVER echoed back — only our own routing (backend/rule/tier).
# enforce_spawns=1 -> hard deny; else a non-blocking allow + additionalContext nudge.
MMT_BE="$D_backend" MMT_BE_DISP="$be_disp" MMT_BE_AGENT="$be_agent" \
MMT_RULE="${D_rule:-?}" MMT_TIER="${D_tier:-?}" \
MMT_ENFORCE="${MMT_PROACTIVE_ENFORCE_SPAWNS:-0}" "$PY" -c '
import os, json
be   = os.environ.get("MMT_BE", "")
disp = os.environ.get("MMT_BE_DISP", be)
agent= os.environ.get("MMT_BE_AGENT", "")
rule = os.environ.get("MMT_RULE", "?")
tier = os.environ.get("MMT_TIER", "?")
enforce = os.environ.get("MMT_ENFORCE", "0") == "1"
how = ("run scripts/run.sh with a forced {\"backend\":\"%s\"} decision (subtask on a single-quoted "
       "heredoc), or spawn the `%s` agent" % (be, agent))
if enforce:
    reason = ("multi-model-team: blocked — this spawned task routes to %s [rule=%s, tier=%s] and "
              "[proactive].enforce_spawns is on. Re-issue it through the plugin CLI dispatch: %s, "
              "so it actually runs on %s instead of a plain Claude agent. "
              "(Set [proactive].enforce_spawns=false for a non-blocking nudge.)"
              % (disp, rule, tier, how, be))
    out = {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}
else:
    ctx = ("multi-model-team: this spawned task routes to %s [rule=%s, tier=%s] per your config. "
           "Prefer dispatching it through the plugin CLI — %s — so it runs on %s and saves Claude "
           "tokens, instead of doing the work in this Claude agent. Configurable nudge: ignore it if "
           "the task needs your in-context judgment or codebase awareness. "
           "(Set [proactive].enforce_spawns=true to make this a hard requirement.)"
           % (disp, rule, tier, how, be))
    out = {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "additionalContext": ctx,
    }}
print(json.dumps(out, separators=(",", ":")))'
exit 0
