---
description: Set up multi-model-team — create your personal roster at ~/.claude/mmt-roster.json (seeded from the shipped default) so your tuning survives plugin updates, and print the next steps (roster precedence + statusline HUD).
argument-hint: "[--force]"
allowed-tools: Bash
---

# /mmt-setup — scaffold your multi-model-team config

Plugin root: `${CLAUDE_PLUGIN_ROOT}`

**Raw input:** $ARGUMENTS

Create the user's personal roster at `~/.claude/mmt-roster.json`. This is **the** place to tune
backends / routes / `team` / `reasoning` — it's read in preference to the plugin's shipped default,
so plugin updates never clobber it.

## 1 · Run the setup script

Run this with the Bash tool. It seeds `~/.claude/mmt-roster.json` from the shipped default and is
**safe to re-run** — it refuses to overwrite an existing personal roster unless `--force` is passed
(pass `--force` through only if the user's `$ARGUMENTS` contains it):

```
node "${CLAUDE_PLUGIN_ROOT}/src/bin/setup.mjs"
```

If the user asked to reset it (their input contains `--force`), run:

```
node "${CLAUDE_PLUGIN_ROOT}/src/bin/setup.mjs" --force
```

Relay the script's output to the user (it prints the created/left-untouched path).

## 2 · Tell the user how config resolves

Roster resolution order (highest first) — **file-based, no env var**:

1. **`<cwd>/.mmt/roster.json`** — project-local roster (per-repo tuning; check it into the project so
   a team shares one routing config).
2. **`~/.claude/mmt-roster.json`** — the personal roster you just created (applies across all projects).
3. **`<plugin>/config/roster.json`** — the shipped default.

Each file is honored only if it exists, falling through to the next tier otherwise. To tune a single
project, copy the relevant sections into `<that repo>/.mmt/roster.json`.

## 3 · Remind about the statusline HUD (optional, one-time)

The HUD is **not** auto-registered. If the user wants it, they add a `statusLine` to their **own**
`~/.claude/settings.json` with the absolute path to this plugin's statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/statusline/statusline.mjs\""
  }
}
```

(Use the real absolute plugin path in place of `${CLAUDE_PLUGIN_ROOT}` — `settings.json` does not
expand it.)

## 4 · Point them at the knobs

Briefly note what they can edit in the roster: `backends` (enable/disable agy/codex), `routes`
(where a task type goes), `team` (the `/team` pipeline roles), `reasoning.panel` (which models
`/reasoning` fans out to), `defaults.preset` (`budget`/`balanced`/`premium`). Routing changes can be
verified with `/route-test`.
