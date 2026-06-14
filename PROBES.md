# Grounded probe findings — agy v1.0.8 (Windows)

Captured 2026-06-13 against the real `agy` CLI. These resolve the plan's open probes
P1/P2 and the non-obvious headless behavior. Source of truth for `backends.sh` / `clean()`.

## Binary
- Path: `C:\Users\WatchAndyTW\AppData\Local\agy\bin\agy.exe`
  (bash form `/c/Users/WatchAndyTW/AppData/Local/agy/bin/agy.exe`; derivable from `$LOCALAPPDATA/agy/bin/agy.exe`).
- Version: `agy --version` -> `1.0.8`.
- Flags (from `--help`, confirmed): `--print`/`-p`/`--prompt`, `--model`, `--add-dir`,
  `--dangerously-skip-permissions`, `--print-timeout` (default `5m0s`), `--sandbox`,
  `--continue`/`-c`, `--conversation`, `--prompt-interactive`/`-i`, `--log-file`.
  Subcommands: `models`, `update`, `install`, `plugin`/`plugins`, `changelog`, `help`.
  **No `--output-format`** — text output only (matches plan).

## THE KEY FINDING — agy needs a TTY (use winpty)
`agy` gates its output on `isatty(stdout)`. When invoked through a normal pipe
(Claude Code Bash/PowerShell tool, hook runner, subagent shell) it **exits 0 and prints
NOTHING**. It only produces output when attached to a real console.

Fix: wrap every invocation in **winpty** (`/usr/bin/winpty`, present on this msys/git-bash):

```
winpty -Xallow-non-tty -Xplain <agy.exe> --print "<prompt>" --model "<name>" \
       --dangerously-skip-permissions --print-timeout 5m
```

- `-Xallow-non-tty` — required when winpty's own stdin isn't a tty (otherwise winpty
  errors `stdin is not a tty`, exit 1).
- `-Xplain` — suppresses ANSI/escape sequences so stdout is plain text.

### P1 — raw `-p` output shape (RESOLVED)
With the recipe above, `agy -p "Say exactly: HELLO"`:
- **stdout** (raw bytes): `48 45 4C 4C 4F 0D 0A` = `HELLO\r\n`. Plain response only.
  No banner, no usage/token line, no ANSI (thanks to `-Xplain`).
- **stderr**: a single cosmetic line
  `Assertion failed: ASSERT_CONDITION("wp != nullptr && cols > 0 && rows > 0") ... winpty.cc:924`
  — winpty teardown noise (it can't read terminal cols/rows over a pipe). Harmless,
  appears AFTER output, does **not** change the exit code (still 0 on success).
- **exit**: 0 on success.

=> `clean()`: take stdout only, strip `\r`, trim trailing newline/whitespace.
   Defensive: also drop any line matching winpty's `Assertion failed:.*winpty\.cc`.
=> HUD token totals are **char estimates** (no usage emitted) — label them `~`.

### `--model` argument format (RESOLVED)
`--model` takes the exact display string from `agy models`, spaces and parens included.
`--model "Gemini 3.5 Flash (Low)" -p "Say exactly: MODELOK"` -> `MODELOK`. Confirmed.

## Model list (`agy models`, from a real console)
`agy models` is itself TTY-dependent (silent/hangs headless; run via winpty or a console).
Available models:
- `Gemini 3.5 Flash (Low)` / `(Medium)` / `(High)`
- `Gemini 3.1 Pro (Low)` / `(High)`
- `Claude Sonnet 4.6 (Thinking)`
- `Claude Opus 4.6 (Thinking)`
- `GPT-OSS 120B (Medium)`

Tier mapping used in `roster.json`:
- `cheap`    = `Gemini 3.5 Flash (Low)`
- `standard` = `Gemini 3.1 Pro (Low)`

## P2 — quota/limit error text + exit code (STILL OPEN)
Not yet hit a real limit. Shipping default `quota_patterns`; will harden on first real
exhaustion. winpty's assertion line is NOT a quota pattern, so no false positive.

## Tooling on this machine (bash/msys)
- `jq`: **missing** -> statusline parses state.json with pure bash/sed (no jq dep).
- `python3`: 3.12.12 (stdlib `json`) -> used by `route.sh`/`run.sh` to parse `roster.json`.
- `winpty`, `timeout`, `sed`, `grep`, `awk`, `perl`: present.
- agy is **not** on bash PATH in this session (added after Claude Code started); scripts
  resolve the binary themselves (env override -> `command -v` -> `$LOCALAPPDATA` path).
