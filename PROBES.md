# Grounded probe findings — agy v1.0.8 (Windows)

> **Historical capture — read with the SUPERSEDED notes.** This file records the raw probe results
> from the original **bash** implementation (2026-06-13/14): the actual CLI bytes, flags, the
> `isatty` discovery, and the model list — all still factually true about the CLIs. But the *plugin's
> implementation* has since moved to **Node ESM** with **node-pty/ConPTY** (not winpty) and a
> **stdin-delivered** codex prompt. Where a section describes the old bash/winpty mechanism, a
> **SUPERSEDED** note points to the live code (`src/lib/backends.mjs`); `backends.sh`, `route.sh`,
> `run.sh`, and the python/jq tooling referenced below were all deleted in the rewrite. `CLAUDE.md`
> is the current source of truth for the implementation.

Captured 2026-06-13 against the real `agy` CLI. These resolve the plan's open probes
P1/P2 and the non-obvious headless behavior.

## Binary
- Path: `C:\Users\WatchAndyTW\AppData\Local\agy\bin\agy.exe`
  (bash form `/c/Users/WatchAndyTW/AppData/Local/agy/bin/agy.exe`; derivable from `$LOCALAPPDATA/agy/bin/agy.exe`).
- Version: `agy --version` -> `1.0.8`.
- Flags (from `--help`, confirmed): `--print`/`-p`/`--prompt`, `--model`, `--add-dir`,
  `--dangerously-skip-permissions`, `--print-timeout` (default `5m0s`), `--sandbox`,
  `--continue`/`-c`, `--conversation`, `--prompt-interactive`/`-i`, `--log-file`.
  Subcommands: `models`, `update`, `install`, `plugin`/`plugins`, `changelog`, `help`.
  **No `--output-format`** — text output only (matches plan).

## THE KEY FINDING — agy needs a TTY
`agy` gates its output on `isatty(stdout)`. When invoked through a normal pipe
(Claude Code Bash/PowerShell tool, hook runner, subagent shell) it **exits 0 and prints
NOTHING**. It only produces output when attached to a real console. *(This finding is still true
and is the whole reason the agy lane needs a pseudo-terminal.)*

> **SUPERSEDED — the live fix is node-pty/ConPTY, not winpty.** The plugin now runs agy under a real
> pseudo-terminal via **node-pty** (`backends.mjs runPty`): **ConPTY** on Windows, **forkpty** on
> POSIX — so `isatty(stdout)` is true with **no visible console**, working from a fully headless
> parent. winpty could NOT allocate a console with non-zero dims from a console-less parent (the
> `winpty.cc:924` assertion below), so it was dropped from the agy path; `platform.ptyWrap` (winpty/
> `script`) survives only as the **POSIX-without-node-pty** fallback. The winpty recipe below is the
> historical bash approach, kept for the byte-level findings — not the current mechanism.

Historical bash fix (superseded): wrap every invocation in **winpty** (`/usr/bin/winpty`):

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

=> `clean()` (now `backends.mjs clean()`): take stdout only, strip `\r` + ANSI/CSI/OSC, trim trailing
   whitespace. *(The winpty `Assertion failed:.*winpty\.cc` line filter still exists in `clean()` for
   the POSIX winpty fallback, but is dead on the primary node-pty/ConPTY path — ConPTY emits no such
   assertion.)*
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
> **SUPERSEDED.** This captured the *bash-era* tool deps. The plugin is now **Node ESM with one
> native dep (`node-pty`)** — no `jq`, no `python3`, no `route.sh`/`run.sh`. `roster.json` is parsed
> by `JSON.parse` (`src/lib/config.mjs`); the statusline parses `state.json` line-by-line in Node
> (`statusline/statusline.mjs`); routing/execution are `src/bin/route.mjs` / `src/bin/run.mjs`.

- `jq`: **missing** -> (bash era) statusline parsed state.json with pure bash/sed. *(Now: Node, no jq.)*
- `python3`: 3.12.12 -> (bash era) `route.sh`/`run.sh` parsed `roster.json` with it. *(Now: `JSON.parse`; those scripts are deleted.)*
- `winpty`, `timeout`, `sed`, `grep`, `awk`, `perl`: present. *(Now off the hot path — only the POSIX winpty/`script` fallback remains.)*
- agy is **not** on bash PATH in this session (added after Claude Code started); the binary is
  resolved by the plugin itself (env override -> PATH scan -> `$LOCALAPPDATA` path) — still true
  (`platform.resolveBinary`).

---

# Grounded probe findings — codex-cli 0.139.0 (Windows)

Captured 2026-06-14 against the real `codex` CLI (OpenAI Codex). Parallel to the agy
section above; contrasts noted explicitly.

## Binary
- Path: `~/AppData/Roaming/npm/codex` (on PATH; resolved via `command -v codex`).
- Version: `codex --version` -> `codex-cli 0.139.0`. Not TTY-gated — runs fine headless.
- Non-interactive entrypoint: **`codex exec [OPTIONS] [PROMPT]`** (alias `codex e`). codex also
  reads the prompt from **stdin** via the `-` sentinel: `codex exec … -`.
  > **SUPERSEDED — the live invoker delivers the prompt on STDIN, not as a positional arg.**
  > `backends.mjs invokeCodex` builds `codex exec … -` and writes the prompt to stdin. This was a
  > deliberate fix: on Windows codex is a `.cmd` shim spawned via `cmd.exe`, which **truncates a
  > multi-line prompt at the first newline** (and expands `%VAR%`) when it rides as an argv element.
  > stdin sidesteps both. The "prompt as positional arg + stdin=`/dev/null`" recipe below is the
  > historical pre-fix approach.

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

`--dangerously-bypass-approvals-and-sandbox` is the read-only DEFAULT's opposite: it is **used** by
the `/team --writable` lane (`roster.json` codex `writable_extra`) so codex can write files + run
commands in its worktree (full-auto). The default `extra` keeps `-s read-only` for the safe text-relay
path. *(Original note said this flag was "not used" — true in the read-only-only era, now stale.)*

## Health check

`codex --version` (not `codex exec`) prints the version line to stdout, exit 0.
Not TTY-gated. Suitable for a fast health gate — now in `backends.mjs health()` (was `backends.sh`).

## Invocation recipe

> **SUPERSEDED** — the live invoker is `backends.mjs invokeCodex` (prompt on stdin via `-`; writable
> mode swaps the sandbox flags). Historical read-only recipe (positional prompt + `/dev/null`):

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

---

# opencode (OpenCode CLI) — grounded findings

Probed live against **opencode 1.18.15** on Windows 11 (bun install, `~/.bun/bin/opencode.exe`).
Everything below was executed, not inferred.

## P1 — no TTY gate (unlike agy)

`opencode run` works through a plain pipe: piped stdout returns the answer, exit 0, no pty needed.
This is the codex-shaped lane, **not** the agy one — no `node-pty`, no winpty, no `script` shim.

## P2 — the prompt goes on STDIN

`opencode run [message..]` takes a positional message, but with **no positional it reads the
message from stdin** — verified with both a single-line and a multi-line prompt. The plugin uses
stdin for the same reason codex does: a multi-line prompt passed as an argv element is truncated at
the first newline by any `cmd.exe` wrapper. There is no `-` sentinel; simply omit the positional.

On Windows the binary is a real `opencode.exe` (not an npm `.cmd` shim), so `winCmdWrap` does not
engage and argv passes through untouched.

## P3 — stream split

- **stdout** — the answer only (already clean).
- **stderr** — the session banner (`> plan · <model>`) and ANSI colour (`ESC[0m`).

`clean()` strips the control bytes regardless.

## P4 — read-only vs writable is an AGENT, not a sandbox flag

`opencode agent list` reports `build (primary)`, `plan (primary)`, `explore (subagent)`,
`general (subagent)`, plus `compaction`/`summary`/`title`.

- `--agent plan` — the read-only lane (verified: answers normally).
- `--agent build --auto` — the read/write lane (verified: wrote a file).

`--auto` auto-approves permissions. The shipped `build` agent already carries `permission: * ->
allow` with `question -> deny`, so a headless run does not stall on a prompt.

## P5 — **opencode IGNORES the spawned process's cwd** (the isolation bug)

The important finding. Spawning `opencode run` with `{ cwd: <target> }` and asking it to create a
file produced **DONE plus the file in the PARENT repo**, not in `<target>`. opencode resolves its
own project root and disregards the cwd it inherits.

Left unfixed this silently defeats `/team --writable`: each subtask gets its own git worktree, and
an opencode subtask would have written into the shared checkout while reporting success.

`--dir <path>` is the supported way to point it at a directory and **does** confine writes there
(verified: file in the target dir, repo root untouched). The plugin passes `--dir` whenever a
`--cwd` is supplied, alongside the spawn cwd, via the roster-tunable `cwd_flag`.

## P6 — models: user-configured, and the default can be VERY slow

`opencode models` lists what the user's own config exposes; on this machine, eight `opencode/*`
entries and three `nixabe/*` ones. The plugin deliberately passes **no `--model`**, so opencode uses
whichever model its own config selects.

Caveat worth knowing: this machine's default (`nixabe/qwen3.6-27b-q4-mtp`) answered a one-word
prompt correctly but took **roughly 40 minutes**, which is beyond the shipped `hard_timeout: 30m`.
A fast model (`opencode/deepseek-v4-flash-free`) answered the same prompt in ~10 s. If your default
model is slow, either pin a faster one in `backends.opencode.models` / `MMT_MODEL_OPENCODE`, or
raise `backends.opencode.hard_timeout`.

## Invocation recipe (live)

```bash
printf '<PROMPT>' | opencode run \
  [--auto] \
  --agent {plan|build} \
  [--model "<PROVIDER/MODEL>"] \
  [--dir "<WORKDIR>"]
```

## P7 — quota/limit error text (OPEN)

Not yet hit a real limit; `quota_patterns` for opencode are unvalidated defaults, same open item as
agy and codex.

---

# codex — auth failure text (RESOLVED into a distinct failure kind)

A live `codex exec` on this machine returned:

```
ERROR: unexpected status 401 Unauthorized: Incorrect API key provided: sk-QZpqv***…
       auth error: 401, auth error code: invalid_api_key
```

`~/.codex/auth.json` held a stale API key. The plugin's broad `quota_patterns` matched this and
reported **"quota/credit limit on 'codex'"** — pointing at billing when the fix was `codex login`.

Auth is now detected **before** quota (`backends.authFromResult`, roster `auth_patterns`) and
surfaces as its own `auth` failure kind, with the handoff reason naming the login fix. Same
failure-gate as quota: a successful answer is never an auth error however it words itself.
