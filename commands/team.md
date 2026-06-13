---
description: Manually route a task and run it through the multi-model-team dispatcher (router + executor), bypassing model judgment. Your deterministic override.
argument-hint: "[task description]"
allowed-tools: Bash
---

# /team — manual deterministic dispatch

**Task to dispatch:**

$ARGUMENTS

---

Run that task through the executor. **Use the Bash tool** to invoke `run.sh`, passing the
task on **stdin via a single-quoted heredoc** so quotes, backticks, `$(...)`, and `;` in the
task are treated as literal data — never interpolate the task into the command string (it is
untrusted text and must not be parsed by the shell):

```
bash "$CLAUDE_PLUGIN_ROOT/scripts/run.sh" <<'MMT_TASK_EOF'
<paste the exact task text here>
MMT_TASK_EOF
```

(Pick a heredoc delimiter that does not appear in the task. `run.sh` reads the task from
stdin when given no argument.)

Then:
- If the script's stdout is the delegated result, present it directly.
- If it begins with `MMT_NATIVE_HANDOFF`, the router chose native Claude (or agy was
  exhausted) — solve the task directly in-context at the indicated tier; do not re-dispatch.
