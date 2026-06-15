---
description: Dry-run the multi-model-team router on a task and print the decision JSON + score breakdown. No model call — pure routing logic, for tuning.
argument-hint: "[task description]"
allowed-tools: Bash
---

# /route-test — dry-run router

**Task to classify:**

$ARGUMENTS

---

Show the routing decision. **Use the Bash tool** to invoke `route.mjs`, passing the task on
**stdin via a single-quoted heredoc** (never interpolate the task into the command string —
it is untrusted text and must not be parsed by the shell):

```
node "$CLAUDE_PLUGIN_ROOT/src/bin/route.mjs" --explain <<'MMT_TASK_EOF'
<paste the exact task text here>
MMT_TASK_EOF
```

(Pick a heredoc delimiter that does not appear in the task. `route.mjs` reads the task from
stdin when given no argument; `--explain` prints the breakdown.)

The output shows the task's char count, detected types, the matched route rule, and the
resolved `{backend, model, tier}`. No backend is invoked. Tune `config/tags.txt` (type
classification) and `config/roster.json` (routes) to adjust decisions.
