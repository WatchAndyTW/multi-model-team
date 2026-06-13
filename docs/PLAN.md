# Original implementation plan (historical)

> This is the original build plan for multi-model-team, preserved for its design rationale.
> The plugin is now **built and tested**; for the *current* shape of the project see
> [`CLAUDE.md`](../CLAUDE.md) and [`README.md`](../README.md), and for grounded CLI behavior
> see [`PROBES.md`](../PROBES.md). Notable ways the build diverged from this plan:
>
> - **agy needs winpty + an open stdin** (the central discovery — not anticipated here; see PROBES.md).
> - **Real model names** are `Gemini 3.1 Pro (Low)` / `Gemini 3.5 Flash (Low)` (the
>   `gemini-3.1-pro` / `gemini-3.5-flash` names below were guesses).
> - **Rule ordering changed:** `bulk-ingest` now precedes `grounded-research`, and
>   `judgment-coding` was moved **above** the commodity agy rules so judgment work isn't
>   stolen by a commodity-type match (found in adversarial review).
> - **No `re-analyst` agent** — the agents are `delegate`, `av-research`, `bulk-summarizer`
>   (RE is Opus-only and never reaches a wrapper).
> - **Slash commands** feed the task on stdin via the Bash tool (not inline `!`exec``) to
>   avoid `$ARGUMENTS` command injection.
> - **No jq** (pure-bash statusline; python `tomllib` for TOML). Health check bypasses winpty.

---

# multi-model-team — Claude Code Plugin Implementation Plan

**Goal:** A Claude Code plugin that lets Opus delegate token-heavy, self-contained tasks to a local pre-authed `agy` (Gemini) CLI, choosing the backend/model dynamically by task size and type, with credit-exhaustion fallback, and a glanceable statusline HUD in Claude Code Desktop. Built agy-only first; codex/opencode added later after testing.

---

## 0. Confirmed environment (from recon)

- Binary: `agy`. One-shot: `-p` / `--print` (aliases `--prompt`). **Text output only — no `--output-format` flag on this version.**
- Model select: `--model` (use the long form; `-m` not present in this build).
- `--dangerously-skip-permissions` — auto-approve tool prompts (needed for headless non-read tasks).
- `--print-timeout` — default 5m.
- `--add-dir` — scope agy to a directory so it reads files itself (token saver for RE dumps).
- `--sandbox` — terminal-restricted run (optional per-rule safety toggle).
- Subcommands: `agy models` (validate configured models), `agy --version` (health pre-flight).
- Auth: pre-authed via Google OAuth in system keyring; inherited by non-interactive calls.

### Open probes (plan is buildable without them; tighten when available)
- **P1 — raw `agy -p` output shape:** does it print only the response or add banner/usage lines? Decides output-stripping in `run.sh` and whether HUD totals are real tokens or char estimates.
- **P2 — quota/limit error text + exit code:** grounds `quota_patterns` / `quota_exit_codes`. Until captured, ship reasonable defaults and harden on first real limit hit.

---

## 1. Directory layout

```
multi-model-team/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── delegate.md            # backend-agnostic workhorse dispatcher
│   ├── re-analyst.md          # RE-framed delegate (IL2CPP/protobuf/disasm), forces standard tier
│   └── bulk-summarizer.md     # cheap-tier delegate for huge compact-return jobs
├── commands/
│   ├── team.md                # /team — manual deterministic dispatch (override)
│   └── route-test.md          # /route-test — dry-run router, print decision + score
├── hooks/
│   └── hooks.json             # Stage 4: PreToolUse guaranteed routing (narrow)
├── statusline/
│   └── statusline.sh          # reads state.json, prints one HUD line
├── config/
│   └── roster.toml            # routing rules, agy backend def, thresholds, quota patterns
└── scripts/
    ├── route.sh               # task -> {backend, model, rule}  (no execution)
    ├── run.sh                 # executes chosen backend, fallback chain, writes state.json
    └── lib/
        ├── score.sh           # size + keyword-type scoring
        └── backends.sh        # agy invocation + flag mapping (extensible)
```

State files (runtime, outside the plugin tree):
- `~/.cache/mmt/state.json` — live HUD state (active set + counters).
- `~/.cache/mmt/quota.flag` — optional TTL cache of "agy exhausted" (Stage 3+).

---

## 2. Config — `config/roster.toml`

```toml
[defaults]
preset       = "balanced"        # budget | balanced | premium (biases tier)
fallback     = "native:sonnet"   # final hop when CLI options exhausted
# When the preferred backend reports quota exhaustion, try these in order
# (agy-only for now; codex/opencode appended later).
quota_fallback = ["agy", "native:sonnet"]

[backends.agy]
cmd          = "agy"
oneshot_flag = "--print"
model_flag   = "--model"
extra        = ["--dangerously-skip-permissions", "--print-timeout", "5m"]
models       = { cheap = "gemini-3.5-flash", standard = "gemini-3.1-pro" }
health       = "agy --version"
list_models  = "agy models"      # used to validate model names at health time
add_dir_flag = "--add-dir"       # optional file-scoping mode
sandbox_flag = "--sandbox"       # optional per-rule safety toggle (default off)
# P2: tune these from a real limit error before trusting fallback.
quota_patterns   = ["quota", "rate limit", "RESOURCE_EXHAUSTED", "429",
                    "exceeded your current quota", "insufficient"]
quota_exit_codes = []            # fill once a real exit code is observed

# --- Dynamic routing rules: first match wins ---
# PHILOSOPHY (from capability research + user intent):
#   THREE BUCKETS, decided by "if Gemini gets this subtly wrong, would I
#   notice immediately?"
#     YES, cheap to catch  -> AGY  (most everyday coding + Gemini's strengths)
#     NO, needs judgment   -> SONNET (codebase context, hard-to-verify, but not systems-hard)
#     RE / injection / heavy -> OPUS  (HARD LINE — never agy)
#   When UNCERTAIN between agy and sonnet, prefer sonnet. When anything smells
#   like RE/injection/systems, it's opus, no matter how small.

# ============================ HARD LINE: OPUS ============================
# RE / injection / binary / systems-hard. ALWAYS Claude Opus, regardless of size.
# Checked FIRST so nothing below can accidentally offload these.
[[route]]
name    = "re-injection-heavy"
when    = { type = ["il2cpp", "protobuf-re", "disasm", "decompile", "vmprotect",
                    "binary", "ffi", "unsafe", "exploit", "hooking", "injection",
                    "dll-inject", "detours", "minhook", "shellcode", "kernel",
                    "memory-patch", "anti-debug", "packer", "manual-map"] }
backend = "native"
tier    = "opus"

# Deep systems / concurrency / agentic / architecture — judgment-critical, not commodity.
[[route]]
name    = "systems-complex"
when    = { type = ["architecture", "agentic", "concurrency", "async-design",
                    "lock-free", "kcp", "protocol-design", "debug-hard",
                    "perf-critical", "proc-macro"] }
backend = "native"
tier    = "opus"

# ============================ AGY: offloadable ============================
# Gemini's categorical edges (Claude can't / trails). Highest-confidence offload.
[[route]]
name    = "multimodal"
when    = { type = ["video", "audio", "watch", "transcribe-av", "image-heavy"] }
backend = "agy"
tier    = "standard"

[[route]]
name    = "grounded-research"
when    = { type = ["websearch", "research-synth", "summarize", "extract",
                    "docs", "ingest", "scan"] }
backend = "agy"
tier    = "standard"

[[route]]
name    = "bulk-ingest"
when    = { min_chars = 20000, type = ["summarize", "extract", "ingest", "scan"] }
backend = "agy"
tier    = "cheap"

# Standard, verifiable coding — the LOOSENED bucket. Most everyday code work.
# If a wrong result is obvious at a glance, agy handles it.
[[route]]
name    = "standard-coding"
when    = { type = ["frontend", "react-component", "css", "html", "ui",
                    "svg", "animation", "3d", "asset-gen", "mockup",
                    "boilerplate", "scaffold", "crud", "rest-endpoint",
                    "script", "cli-tool", "glue-code", "data-transform",
                    "sql-query", "regex", "config-file", "dockerfile",
                    "rename", "format", "codegen", "unit-test", "fixture"] }
backend = "agy"
tier    = "standard"

# Cheap/fast trivia — tiny, throwaway, zero-judgment.
[[route]]
name    = "trivial"
when    = { type = ["quick-email", "rename", "format", "one-liner",
                    "explain-snippet"], max_chars = 4000 }
backend = "agy"
tier    = "cheap"

# ============================ SONNET: middle ============================
# Code needing judgment / your codebase's context / hard to verify at a glance,
# but NOT systems-hard. The thoughtful-but-not-RE middle.
[[route]]
name    = "judgment-coding"
when    = { type = ["refactor", "integration", "bugfix", "api-design",
                    "state-management", "data-model", "migration",
                    "review", "production-logic", "edge-cases"] }
backend = "native"
tier    = "sonnet"

# Default when UNCLASSIFIED — prefer sonnet (safe middle), never agy on a guess.
[[route]]
name    = "catch-all-safe"
when    = {}
backend = "native"
tier    = "sonnet"
```

Rule semantics: first match wins, and **order encodes priority** — the OPUS hard-line rules sit at the top so an RE/injection task can never fall through to a coding rule below and get offloaded. Below that, agy's rules are checked before Sonnet's, but agy's matchers list *concrete commodity types* — a task only reaches agy on a clear type match. Anything unmatched drops to `catch-all-safe` (Sonnet), never agy. `preset`: `budget` pushes borderline `judgment-coding` down to agy-standard; `premium` pulls `standard-coding` up to Sonnet and keeps agy only for rules 1–3 (its categorical edges).

### The Sonnet-vs-agy line, stated plainly
| Goes to **agy** | Goes to **Sonnet** |
|---|---|
| New React component, CSS, UI, SVG/animation | Refactoring *existing* code in your repo |
| Boilerplate, scaffolding, CRUD, REST endpoints | Integration touching multiple of your modules |
| Standalone scripts, CLI tools, glue code | Bugfixes needing root-cause judgment |
| SQL queries, regex, configs, Dockerfiles | API/data-model *design* decisions |
| Unit tests, fixtures, data transforms | Production logic with tricky edge cases |
| Web search, doc/research summarization | Anything where you'd have to read it carefully to trust it |
| Video/audio (Claude can't anyway) | Unclassified / uncertain tasks |

### The hard line (never agy, always Opus)
RE, IL2CPP, protobuf reverse-engineering, disassembly, decompilation, VMProtect, DLL injection, Detours/MinHook hooking, FFI, unsafe, shellcode, memory patching, anti-debug, manual mapping — **plus** deep systems work: concurrency, lock-free, protocol design (KCP), proc-macros, perf-critical paths. Size is irrelevant here: a 10-line `unsafe` FFI shim is still Opus.

---

## 3. Router — `scripts/route.sh`

Pure decision logic, no model calls. Input: task text (stdin/arg). Output: one JSON line `{"backend","model","rule","tier","score":{...}}`.

1. **Score** (`lib/score.sh`): char count + keyword classifier tagging task type via per-type regex sets (sourced from a tags file so tuning needs no code edits).
2. **Match** `[[route]]` rules in order, first hit wins.
3. **Apply preset** to resolve final tier→model.
4. **Health-gate** the chosen backend (`agy --version`; optionally validate model against `agy models`). On fail, fall to next viable rule, then `defaults.fallback`.
5. Emit decision JSON.

`/route-test` runs this in dry-run for tuning.

---

## 4. Executor — `scripts/run.sh`

Consumes router decision + task; runs the backend with fallback; writes HUD state.

Core loop (fallback chain = preferred backend + `quota_fallback`, deduped):
```
for backend in chain:
    health_ok(backend) or continue                  # pre-flight
    state_write(start, id, backend, model, rule)     # HUD
    out, err, code = invoke(backend, task)
    state_write(end, id, code, dur, out_chars)       # HUD
    if quota_exhausted(backend, out, err, code):     # post-call (P2 patterns)
        continue                                     # next backend
    if code != 0: continue                           # non-quota error -> fall through
    return clean(out)                                # success
return native_fallback(task)                         # all exhausted
```

Details:
- **Invocation** built from `roster.toml`: `agy --print "<task>" --model <model> --dangerously-skip-permissions --print-timeout 5m`. Adding/fixing a CLI is config-only.
- **Hard timeout** via coreutils `timeout` as a backstop independent of `--print-timeout`.
- **Output cleaning** (`clean()`): strip ANSI; **P1 decides** whether any banner/usage lines must be trimmed to leave only the response.
- **Compact-return contract:** prepend "Return only the result, no preamble." to the delegated prompt — the whole savings model depends on a small return crossing back to Opus.
- **`--add-dir` mode (optional):** when the task references a local file, pass `--add-dir <dir>` and let agy read it on Google's quota instead of stuffing content through Opus.
- **`quota_exhausted()`:** check `quota_exit_codes` then case-insensitive grep of `quota_patterns` over stdout+stderr.
- **`native_fallback()`:** returns a sentinel telling the subagent to solve in-context (Sonnet). Guarantees completion; note this degrades to normal Anthropic cost (acceptable: correctness over cost when CLIs are dry).

---

## 5. HUD — `statusline/statusline.sh` (Claude Code Desktop)

Glanceable, single-line, native to Desktop chrome. No tmux/web/sidecar.

- `run.sh` writes `~/.cache/mmt/state.json` on call start/end: active set (id, backend, model), running counters (calls, fallbacks, approx session in/out).
- `statusline.sh` is a trivial `cat + parse + echo` (must be fast — Claude Code re-invokes it frequently):
  - Active: `⟳ agy·gemini-3.1-pro │ 2 open │ last 3.4s ✓ │ ~12k↓`
  - Idle: `◦ agy idle │ 5 calls · 1 fallback`
- **P1 dependency:** session token total is real only if `agy -p` emits usage; otherwise it's a clearly-labeled char estimate (`~12k↓`), never a guessed number shown as authoritative.
- **Fallback if Desktop blocks statusline customization:** the `delegate` subagent prints a compact one-line status in-chat instead. Confirm statusline registration works on your Desktop version during Stage 2.5.

---

## 6. Agents

**`agents/delegate.md`** — `tools: Bash`, `model: haiku` (near-free routing turn). Description: delegates standard, verifiable coding (new components, CSS/UI, scaffolding, CRUD, scripts, CLI tools, SQL, configs, unit tests) plus Gemini's edges (multimodal, web-research, doc summarization, bulk ingestion) where the *result is compact or easy to verify*; explicitly NOT for RE, injection, FFI/unsafe, binary, concurrency, or anything systems-hard. Instructions: pass task to `route.sh`, feed decision to `run.sh`, return stdout verbatim, stderr verbatim on error — no analysis. If the router returns `native`, it returns a sentinel and Opus/Sonnet handles it — the delegate never forces offload.

**`agents/av-research.md`** — same shape; targets Gemini's categorical edges Claude lacks: "watch/summarize video, transcribe/analyze audio, synthesize web-research, summarize large grounded documents." Highest-confidence offload (Claude can't do A/V at all). Tier `standard`.

**`agents/bulk-summarizer.md`** — pinned to `agy cheap`; targets "summarize/extract from very large text where a short grounded answer suffices." Cheapest path; ingestion, not judgment.

> Note: there is intentionally **no** RE/injection delegate agent. That work hits routing rules 1–2 (opus) and never reaches a wrapper. The HARD LINE — RE, IL2CPP, protobuf-RE, disasm, VMProtect, DLL injection, Detours/MinHook, FFI, unsafe, shellcode, memory patching, plus deep systems (concurrency, KCP/protocol design, proc-macros, perf-critical) — is Opus only, regardless of task size.

All three are registered like native subagents, so they're in the candidate pool for Opus's in-session dynamic workflows (one hop: Opus → wrapper → return).

---

## 7. Commands

- **`/team <task>`** — manual deterministic dispatch; bypasses Opus judgment, runs router+executor directly. Your override.
- **`/route-test <task>`** — dry-run router; prints decision JSON + score breakdown. Tuning tool, no model call.

---

## 8. Hook (Stage 4) — `hooks/hooks.json`

`PreToolUse` interceptor for **guaranteed** routing of a narrow class only — e.g. `Read` of files matching `*.dump`/`*.il2cpp` above a size threshold, or `Bash` matching disasm/dump patterns. On match, short-circuit to `run.sh` and return the delegated result instead of letting Opus do the heavy read. Keep the match set deliberately narrow at first; widen only after observing real routing. This is the deterministic complement to description-driven subagent dispatch.

---

## 9. Build & verification stages

| Stage | Deliverable | Verify |
|---|---|---|
| 1 | `roster.toml` + `route.sh` + `score.sh` | `/route-test` on ~12 sample tasks (RE snippet, 30k dump, 2-liner, refactor); pure logic, no model calls |
| 2 | `run.sh` + `backends.sh` (agy) + fallback + `state.json` writes | `/team` real agy calls; confirm keyring carries into headless mode; **resolve P1** from live output; confirm timeout + clean() |
| 2.5 | `statusline.sh` + Desktop registration | Status updates near-live during a `/team` call; if blocked, switch to in-chat status fallback |
| 3 | Three subagents (`delegate`, `re-analyst`, `bulk-summarizer`) | Give Opus a mixed task; confirm it spawns the right wrapper on its own for heavy parts |
| 4 | `PreToolUse` hook (narrow) | Targeted op routes deterministically; everything else untouched |
| 5 | Cost check | Run a representative RE workflow with plugin on vs off; compare Anthropic token spend |
| Later | codex + opencode rows | Config-only additions once their flags + quota patterns confirmed; health-gate so unavailable CLI falls through |

---

## 10. Risks & mitigations

- **Return-cost leakage** (the recurring trap): large delegated outputs re-ingested by Opus erase savings. Mitigation: compact-return contract + cheap summarizer + Stage 5 measurement.
- **Quota misdetection** (P2): a fallback that misreads a quota error as a valid result is worse than none. Mitigation: ground `quota_patterns`/`quota_exit_codes` on a real sample before trusting fallback; until then, default patterns + manual watch.
- **agy flag/model drift:** all invocation in `roster.toml` + `backends.sh`; validate models via `agy models` at health time.
- **Statusline cadence/perf:** refresh is Claude Code's call (near-live, not frame-perfect); keep `statusline.sh` trivially fast or it laggs the UI.
- **Hook over-reach:** start narrow, widen on evidence.
- **Native fallback cost:** full-exhaustion path degrades to normal Anthropic cost by design; if you'd rather fail loudly than silently spend, make the final fallback an error return instead.

---

## 11. Immediate next step

Provide P1 (raw `agy -p "Say exactly: HELLO"` output) so Stage 2's `clean()` and the HUD token-vs-estimate decision are grounded. Stage 1 can be written now against confirmed flags in parallel.
