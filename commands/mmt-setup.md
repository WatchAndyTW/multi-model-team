---
description: Set up (or re-sync) the multi-model-team proactive config durably — writes an external MMT_ROSTER outside the plugin cache (so it survives updates) and wires it into ~/.claude/settings.json. Use --enforce for hard spawn-blocking, --sync to refresh after a plugin update, --status to inspect.
argument-hint: "[--enforce] [--disable] [--sync] [--status]"
allowed-tools: Bash
---

# /mmt-setup — durable proactive config

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw args:** $ARGUMENTS

The proactive nudges live in `roster.json`, a tracked plugin file — so editing the cached roster
is **wiped on every plugin update**. This command sets up the durable pattern instead: an external
roster outside the cache, pointed at by the `MMT_ROSTER` env var in `~/.claude/settings.json`.

**Run the setup engine with the raw args forwarded verbatim** (the args above are plain flags, not
untrusted prose — but still pass them as separate tokens, never build a shell string from free text):

```
node "${CLAUDE_PLUGIN_ROOT}/src/bin/setup.mjs" $ARGUMENTS
```

What it does by mode:
- **no args** → writes/refreshes the external roster with `proactive.enabled=true` (soft nudge) and
  sets `env.MMT_ROSTER` in `~/.claude/settings.json`. Idempotent.
- **`--enforce`** → same, but `enforce_spawns=true` (hard-DENY CLI-routable `Task`/`Agent` spawns so
  they must re-dispatch through the plugin CLI). **`--nudge`** flips it back to soft.
- **`--disable`** → set `proactive.enabled=false` (leaves the settings wiring in place).
- **`--sync`** → refresh the external roster's base FROM the current plugin `config/roster.json`
  while preserving your `[proactive]` toggles. Run this after updating the plugin. Doesn't touch settings.
- **`--status`** → print the current external-roster proactive state + whether settings is wired.

After running, report the script's output to the user, then tell them:

1. **Restart Claude Code** if it set/changed `env.MMT_ROSTER` (the env var is read at launch).
2. **Scope reminder:** even `--enforce` only governs **agent spawns** — it hard-blocks a `Task`/`Agent`
   spawn whose work routes to agy/codex, forcing a CLI re-dispatch. It **cannot** force Claude to
   delegate work it does *inline* (no tool call to intercept). The deterministic ways to actually run
   on the CLIs remain **`/team`** or explicitly spawning the **`multi-model-team:agy`** /
   **`multi-model-team:codex`** agents.
