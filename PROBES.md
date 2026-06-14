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

---

# Grounded probe findings — codex-cli 0.139.0 (Windows)

Captured 2026-06-14 against the real `codex` CLI (OpenAI Codex). Parallel to the agy
section above; contrasts noted explicitly.

## Binary
- Path: `~/AppData/Roaming/npm/codex` (on PATH; resolved via `command -v codex`).
- Version: `codex --version` -> `codex-cli 0.139.0`. Not TTY-gated — runs fine headless.
- Non-interactive entrypoint: **`codex exec [OPTIONS] [PROMPT]`** (alias `codex e`).
  The prompt rides as the positional arg. If stdin is piped AND a prompt arg is given,
  codex appends stdin as a `<stdin>` block — so invoke with stdin = `/dev/null` (or
  the equivalent held-closed) to avoid spurious context injection.

## THE KEY DIFFERENCE vs agy — no winpty, no TTY gating

`codex exec` is **not TTY-gated**. It runs fine through a normal pipe (Bash tool,
hook runner, subagent shell) and produces output without any winpty wrapper.
No `winpty`, no open-stdin FIFO, no output-scrubbing gymnastics required.

## P1 — output shape (RESOLVED)

`codex exec -s read-only --skip-git-repo-check --color never "Reply with exactly the single word: CODEXOK"`:
- **stdout**: exactly `CODEXOK`. Final assistant message only. No banner, no ANSI
  (with `--color never`).
- **stderr**: session id, token usage line, "Shell cwd was reset…" diagnostics —
  all noise goes to stderr, not stdout. Capture stdout alone; discard/ignore stderr.
- **exit**: 0 on success.

=> `clean()` for codex: take stdout only, strip trailing whitespace/newline.
   No ANSI stripping needed when `--color never` is passed.
   No winpty assertion-noise line to filter (contrast with agy).
=> Token totals ARE emitted — on stderr — so they could be parsed if desired;
   for now, HUD token estimates are char-based (`~`) to stay consistent with agy.

## Flags we use

| Flag | Purpose |
|---|---|
| `-s read-only` | Sandbox mode: disallow file modifications (values: `read-only`, `workspace-write`, `danger-full-access`). Safe default for a "produce text" relay. |
| `--skip-git-repo-check` | Allow invocation outside a git repo. |
| `--color never` | Suppress ANSI escape sequences; clean stdout. |
| `-m <MODEL>` | Model selector (omitted → codex's own `config.toml` default). |
| `--add-dir <DIR>` | Extra readable directory to expose. |

`--dangerously-bypass-approvals-and-sandbox` exists but is NOT used — `read-only` is
safer for relay use.

## Health check

`codex --version` (not `codex exec`) prints the version line to stdout, exit 0.
Not TTY-gated. Suitable for a fast health gate in `backends.sh`.

## Invocation recipe

```bash
codex exec \
  -s read-only \
  --skip-git-repo-check \
  --color never \
  [-m "<MODEL>"] \
  "<PROMPT>" \
  </dev/null
```

stdout = clean assistant response; stderr = diagnostics (discard or log).

## P2 — quota/limit error text + exit code (OPEN)
Not yet hit a real limit. `quota_patterns` for codex are unvalidated defaults; harden
on the first real exhaustion event (same open item as agy P2).
