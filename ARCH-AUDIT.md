# yoinks — architecture audit (re-run after fixes)

> The fix plan this audit led to (`FIX-PLAN.md`) shipped in full and was removed; `git show 8e67e62:FIX-PLAN.md` shows it.

Config: MODE=AGENTIC-REPO · PROJECT_STAGE=Early Production [INFERRED: published to npm, v0.3.1, 14 unit tests, `prepublishOnly` gate, CI workflow present but never executed] · TEAM_SIZE=UNKNOWN (not a git checkout, no CODEOWNERS; `package.json` names one author, so solo is a [HYPOTHESIS]) · SCOPE=`src/**` non-test code + `package.json`, `tsconfig.json`, `tsup.config.ts`, `.github/workflows/ci.yml`, `README.md` · AUDIT_BUDGET=40 files / 15k LOC, used 24 files / ~2.2k LOC.

Missing HIGH-VALUE inputs: ADRs [UNKNOWN — ADRs not provided]; architecture doc [UNKNOWN — none; README "How it works" is the only design text]; deployment manifests [N/A — npm CLI]; CI run history [UNKNOWN — the workflow in `.github/workflows/ci.yml` has never run, the folder is not a git checkout].

---

## Status update (after commits 5de3672 and 1a5a8a5, CI green)

Written after the audit below. Line numbers and "never run" claims in the sections below predate this update; this block wins on conflict.

| ID | Now | Evidence |
|---|---|---|
| A-02 | CLOSED | `ytdlp.ts` 395 lines (was 524); provisioning in `provision.ts` (130), `withTimeout` in `timeout.ts` (22) |
| A-09 | PARTLY CLOSED | `withTimeout` tested with fake timers (`timeout.test.ts`); `checksumFor` in `provision.test.ts`; 17 tests total. `spawn`/`fetch` still not injectable; `probe`, `download`, `ensureYtDlp` untested |
| A-10 | CLOSED | CI run 42110813785 green on {ubuntu, windows} × {Node 22, lts/*} |
| A-11 | CLOSED | CI found `ink@7.1.0` needs Node ≥22; `engines`, `tsup` target, README and CI matrix now say 22 |
| A-14 | CLOSED, behavior [HYPOTHESIS] | `SILENCE_LIMIT_MS` `ytdlp.ts:272` per phase (`preparing` 2 min, `downloading` 90 s, `processing` none); not exercised against a real dead connection |

### Second update (scriptable mode, playlists, split)

| ID | Now | Evidence |
|---|---|---|
| A-01 | CLOSED | `app.tsx` 301 lines (was 522); workflow in `lib/use-yoink-flow.ts` (169), views in `components/download-view.tsx`, `choice-list.tsx`, `gap.tsx`. Driven end to end with a fake TTY and real yt-dlp: probe → picker → download → done → input |
| A-03 | PARTLY CLOSED | `activeChild` is now a `Set` (`activeChildren`); `frameLines` (click-map) and cli `outcome` stay module-level, single-use |
| A-04 | MITIGATED | `info-files.ts` `sweepStaleInfoFiles` removes `yoinks-info-*.json` older than 24 h at each probe; a SIGKILL leak now lasts at most a day. Tested |
| A-05 | CLOSED | `theme-mode.ts` holds the guard; `args.ts` no longer imports `theme.ts` |
| A-06 | CLOSED | `parseArgs` rejects a non-http(s) url; tested |
| A-09 | PARTLY CLOSED | `spawn` is stubbed in tests (`ytdlp-stall`, `headless`, `provision-update`); `fetch` stubbed in `provision-fetch`. `probe` still has no test. 35 tests |
| A-13 | MITIGATED | `YOINKS_DEBUG=1` logs argv, exit code and full stderr to `~/.yoinks/debug.log` (`debug.ts`, tested) |
| A-14 | CLOSED, tested | the `processing` phase never trips the watchdog (test), the downloading phase does (test) |
| D-04 | VERIFIED | `ink-select-input` `SelectInput.js` handles `j`/`k` and keys 1–9 |
| Roadmap | DONE | `--best`, `--mp3`, `--playlist`, `-o/--output`, `install.sh`. Interactive playlist picker is NOT built: a playlist link shows a message pointing at `--playlist` |

Still open: A-15 (same-release checksum; stronger verification not attempted), the interactive playlist picker, `probe` without a test, and no live run of the `-U` updater against GitHub (its call logic is tested with a stubbed spawn).

---

## Delta since the previous audit

The previous audit's rubric was misapplied in two dimensions (see Phase 6), so its 7/10 and this audit's 8/10 are not a like-for-like comparison.

| Old ID | Status | Evidence |
|---|---|---|
| A-07 unverified binary | CLOSED (residual in A-15) | `checksumFor` `ytdlp.ts:37`, compare before `chmod`/`rename` `ytdlp.ts:78-84`; 1 unit test; a first-run fetch with an empty `PATH` and temp home passed the check and installed a working binary (executed) |
| A-08 no timeouts | MITIGATED, behavior [HYPOTHESIS] | `FETCH_TIMEOUT_MS` `:97`, `PROBE_TIMEOUT_MS` `:98`, `STALL_MS` `:402` + watchdog `:450`; never exercised against a dead connection |
| A-09 / A-02 parser buried in `download` | PARTLY CLOSED | `parseDownloadLine` `:362` is pure with 2 tests; spawn/fetch seams and the orchestration around them remain (A-09, A-02 below) |
| A-10 no CI | PARTLY CLOSED | `.github/workflows/ci.yml` runs test/typecheck/build on {ubuntu, windows} × {Node 18, lts}; never executed |
| A-12 unquoted glob | CLOSED | `package.json` `"test": "tsx --test \"src/**/*.test.ts\""`; `npm test` ran 14 tests (executed, Windows) |
| D-01, D-02, D-03 | CLOSED | README roadmap ticks and `npm test` line match `use-clipboard-url.ts`, `ytdlp.ts:128`, `package.json` |

---

## Phase 1 — Detected architecture and intent

**DETECTED ARCHITECTURE: small layered TUI app with a state-machine container (React/Ink), one adapter module around an external CLI.** [VERIFIED]

Citations: `src/cli.tsx` composition root (arg parse → alt-screen → `render(<App/>)`); `src/app.tsx:88-100` `Phase` union drives all screens; `src/lib/ytdlp.ts:189` single spawn factory around yt-dlp; `src/components/*` presentational only (each imports only `theme.js`, plus `text-input.tsx` → `lib/use-mouse-click`); `src/lib/*.ts` pure helpers and hooks.

| # | Item | Finding |
|---|---|---|
| 1 | Pattern | Layered + state machine + adapter (anti-corruption layer) around yt-dlp [VERIFIED] |
| 2 | Dependency graph | Import walk with `grep` over `src/**`; re-run this audit, unchanged edges plus `ytdlp.ts` → `node:crypto`. Structural, so [VERIFIED] |
| 3 | De-facto rule | `cli → app → {components, lib}`; `components → theme`; `lib → lib, theme`. `app.tsx` is imported only by `cli.tsx:4`; no `lib/` file imports a component [VERIFIED] |
| 4 | Domain candidates | yt-dlp adapter (`ytdlp.ts`); terminal input (`click-map.ts`, `use-mouse-click.ts`, `text-input.tsx`); clipboard (`clipboard.ts`, `use-clipboard-url.ts`); theme; persistence (`history.ts`). The only "domain" logic is format selection `buildChoices` `:258` |
| 5 | Entry points | One: `src/cli.tsx` (`bin` in `package.json`). Path: `cli` → `App` → `startProbe` (`app.tsx:180`) → `handlePick` (`app.tsx:259`) |
| 6 | Data flow | yt-dlp stdout parsed per line, pushed to React state via `DownloadHandlers`; probe is request/response [VERIFIED] |
| 7 | Config / secrets | Hard-coded constants (`OUT_DIR` `app.tsx:34`, `YOINKS_DIR` `ytdlp.ts:11`, `HISTORY_FILE` `history.ts:5`). No env config; no secrets [VERIFIED] |
| 8 | Paradigm | `lib/*`: FP-style pure functions (`buildChoices`, `parseDownloadLine`, `checksumFor`, `parseArgs`). `app.tsx`: hooks + refs. No classes [VERIFIED] |
| 9 | Patterns (cited) | State machine `app.tsx:88`; Adapter/ACL `ytdlp.ts:189` + `cleanYtDlpError` `:517`; Pure line-protocol parser `ytdlp.ts:362`; Policy predicate `isExpiredLinkError` `:333`; Observer/callback `DownloadHandlers` `:322`; Hook-with-cleanup `use-clipboard-url.ts`, `use-mouse-click.ts:20`; Proxy `captureFrames` (`click-map.ts`); Timeout wrapper `withTimeout` `:101` |
| 10 | Enforcement tooling | NONE for boundaries: no eslint, dependency-cruiser. `tsc --noEmit` strict + CI workflow (unrun) [VERIFIED: `package.json`, `.github/workflows/ci.yml`] |

**INTENT BASELINE: layered (UI → container → adapter/helpers) — source: dominant detected pattern [HYPOTHESIS].** Every drift finding inherits the [HYPOTHESIS] cap.

---

## Ledger (open findings)

| ID | Lens | Location | Rule / property violated | Evidence | Severity | Blast | Reach | Citations |
|---|---|---|---|---|---|---|---|---|
| A-01 | P2 hotspot, P5 God module | `src/app.tsx` | One file owns the state machine, download workflow (retry, ffmpeg lookup, history write), click-target table, layout and view helpers | [HYPOTHESIS] | MEDIUM | MODULE | REACHABLE | 523 lines (unchanged), 14 internal imports `app.tsx:7-32`; `handlePick` `:259` runs workflow in a component |
| A-02 | P5 God module | `src/lib/ytdlp.ts` | Nine roles in 524 lines (was 409): binary provisioning + checksum (`:49`), self-update (`:128`), timeout helper (`:101`), ffmpeg discovery (`:144`), probe, format policy (`:258`), download + watchdog (`:407`), line parser (`:362`), temp-file lifecycle (`:196-214`) | [HYPOTHESIS] | MEDIUM | MODULE | REACHABLE | single consumer `app.tsx:20-32`; the file grew 28% since the last audit, all of it provisioning/robustness code |
| A-03 | P3 shared mutable state | `ytdlp.ts:404`, `:198`; `click-map.ts:12`; `cli.tsx:73` | Module-level mutable state: `activeChild`, `infoFiles`, `frameLines`, `outcome`; 3 `process.on('exit')` handlers registered at import | [VERIFIED] structural | LOW | MODULE | REACHABLE | `activeChild` is a single slot; whether two downloads can interleave is runtime, [HYPOTHESIS]; the UI starts one after a multi-second probe |
| A-04 | P3 temporal coupling | `ytdlp.ts:196-214,241` vs `app.tsx:194,214-222` | Adapter creates a temp file and exposes its path; caller must release via `discardInfoJson` | [VERIFIED] | LOW | MODULE | GUARDED | exit-time backstop `ytdlp.ts:199-206`; single release point `resetToInput` `app.tsx:214`; a SIGKILL can still leak the file [HYPOTHESIS] |
| A-05 | P3 layer leak | `src/lib/args.ts:1` | Pure CLI parsing imports `../theme.js` (a React-context module) for `isThemeMode` | [VERIFIED] | LOW | LOCAL | REACHABLE | `args.ts:1`, `theme.ts:1` |
| A-06 | P3 trust boundary | `cli.tsx` → `app.tsx` `useEffect` → `startProbe` | Typed input is validated with `isProbablyUrl`, the CLI-arg path is not; `-`-prefixed args are rejected by `parseArgs` so option injection is not reachable | [VERIFIED] | LOW | LOCAL | REACHABLE | `args.ts:30-38`, `app.tsx:203-205`, `platforms.ts:35` |
| A-09 | P3 testability | `ytdlp.ts:1,22,63,407` | `spawn` and `fetch` are used directly, no injection seam. The new timeout, checksum-gate, watchdog and `close`-handler logic runs only against a real yt-dlp/network | [VERIFIED] | MEDIUM | MODULE | REACHABLE | 14 tests: `args` ×5, `panel` ×1, `ytdlp` ×8 (all on pure functions); zero tests for `probe`, `download`, `ensureYtDlp`, `updateIfStale`, `withTimeout`, `format.ts`, `history.ts`, `platforms.ts`, `click-map.ts`, `app.tsx` |
| A-10 | P3 CI | `.github/workflows/ci.yml` | CI exists but has never run, and enforces no boundary rules (conformance by convention) | [UNKNOWN — never executed; not a git checkout] | LOW | SYSTEM | REACHABLE | workflow file; no lint config |
| A-11 | P5 version skew | `package.json` | `engines.node >=18` / `tsup target node18`, but `@types/node ^26`, `typescript ^7`; types permit APIs newer than 18. CI matrix now includes Node 18 but has not run | [VERIFIED] config / consequence [UNKNOWN] | LOW | EXTERNAL | REACHABLE | `package.json`, `ci.yml` matrix |
| A-13 | P6 observability | whole repo | No logging or debug flag; only the last `ERROR:` line survives | [VERIFIED] absence | LOW | LOCAL | REACHABLE | `cleanYtDlpError` `ytdlp.ts:517` |
| A-14 | P5 failure semantics | `ytdlp.ts:402,450` | The stall watchdog treats 90 s of total silence as a dead connection. It also runs during extraction (when `--load-info-json` is absent, e.g. the 403/410 retry) and during any post-processor other than Merger/ExtractAudio, which do not set `processing`; a slow-but-alive run could be killed | [HYPOTHESIS] | LOW | LOCAL | REACHABLE | `processing` is set only on `[Merger]`/`[ExtractAudio]` lines `:380-386`; resolve with a download on a slow site or a long re-extraction |
| A-15 | P5 supply chain | `ytdlp.ts:49-90,128-139` | Residual after the checksum fix: the checksum file and the binary come from the same GitHub release, so this guards corruption and partial tampering, not a compromised release. The 7-day `-U` path relies on yt-dlp's own verification, which is not in this repo | [VERIFIED] code / [UNKNOWN] `-U` behavior | LOW | EXTERNAL | REACHABLE | `RELEASE_BASE` `:12`; resolve by reading yt-dlp's updater docs/source |
| D-04 | Docs unverified | `README.md` Usage | "↑/↓ (or j/k, or number keys)" depends on `ink-select-input`, not on this repo | [UNKNOWN] — press `j` / `2` in the picker | LOW | LOCAL | UNKNOWN | `app.tsx` `SelectInput` usage |

---

## Phase 2 — Module matrix

| Module | Detected pattern | Baseline (source) | Drift | Ledger IDs | Max severity | Evidence |
|---|---|---|---|---|---|---|
| `cli.tsx` | Composition root | layered (HYPOTHESIS) | NONE | A-03, A-06 | LOW | `cli.tsx:60-98` |
| `app.tsx` | Container + state machine + workflow | layered (HYPOTHESIS) | MINOR | A-01, A-04, A-06 | MEDIUM | `app.tsx:259-300` |
| `lib/ytdlp.ts` | Adapter + policy + I/O + provisioning | layered (HYPOTHESIS) | MINOR | A-02, A-03, A-04, A-09, A-14, A-15 | MEDIUM | whole file |
| `lib/click-map.ts`, `use-mouse-click.ts`, `text-input.tsx` | Terminal input plumbing | layered | NONE | A-03 | LOW | `click-map.ts:12` |
| `lib/clipboard.ts`, `use-clipboard-url.ts` | Async adapter + hook | layered | NONE | — | — | `use-clipboard-url.ts` |
| `lib/args.ts`, `theme.ts` | Pure parse / context | layered | MINOR | A-05 | LOW | `args.ts:1` |
| `lib/history.ts`, `platforms.ts`, `format.ts` | Pure helpers / persistence | layered | NONE | — | — | read in full |
| `components/*` | Presentational | layered | NONE | — | — | none imports `app` or `lib/ytdlp` |

**Cycles:** none [VERIFIED by import walk]. **Layer leaks:** A-05 only. **Shared mutable state:** A-03. **Hotspots:** `app.tsx` efferent 14 / afferent 1; `ytdlp.ts` afferent 1 (`app.tsx`) with 524 lines. **Boundary bypass:** none; `app.tsx` never spawns a process.

## Phase 3 — Testability, seams, observability, CI

- Tiers: unit only. Zero-coverage layers: `probe`/`download` orchestration, provisioning/update, persistence, input plumbing, `app.tsx` (A-09).
- Seams: pure functions run without I/O (`buildChoices`, `parseDownloadLine`, `checksumFor`, `isExpiredLinkError`, `parseArgs`). `spawn`/`fetch` not injectable (A-09).
- Observability: absent (A-13).
- CI: workflow present, unrun, no boundary enforcement (A-10).

## Phase 4 — AI orchestration

[N/A — not an AI orchestration project]

## Phase 5 — Anti-patterns

| Pattern | Verdict | ID |
|---|---|---|
| God module | `app.tsx`, `ytdlp.ts` (growing) | A-01, A-02 |
| Temporal coupling | probe → discard | A-04 |
| Infrastructure leakage | `ProbeResult.infoJsonPath` | A-04 |
| Under-engineering | no spawn seam; the orchestration logic around the now-pure parser has 1 call site per function, so no duplication to remove — stays [HYPOTHESIS] | A-09 |
| Premature abstraction / over-engineering | none: `withTimeout` is used at 2 call sites (`:63`, `:217`); no unused interface | — |
| Anemic domain, hidden monolith, shared DB, orchestrator bottleneck | not applicable / not detected | — |

---

## Phase 6 — Score

**ARCHITECTURE SCORE: 8 / 10**

| Dimension | Score | Reason |
|---|---|---|
| Separation of concerns | 2 | Boundaries respected; one LOW leak (A-05), ≤2 modules |
| Consistency with baseline | 2 | No MAJOR drift anywhere (only MINOR in 3 modules). *Previous audit gave 1; the rubric gives 2 for "no MAJOR drift".* |
| Coupling & dependency health | 1 | No cycles, but a shared-mutable-state finding exists (A-03), so the rubric's 2 is unavailable. *Previous audit gave 2 in error.* |
| Testability & observability | 1 | Pure core tested, no injectable I/O seams (A-09), no tracing/logging (A-13) |
| Failure resilience & scalability | 2 | Every external call now has a bound: `commandWorks` 10 s (`:22`), update 60 s (`:134`), fetch 5 min (`:97`), probe 2 min (`:98`), download stall 90 s (`:402`), clipboard 2 s; fallbacks: system → local → fetched yt-dlp, system → bundled ffmpeg, fresh extraction on 403/410. Behavior under real failure is [HYPOTHESIS] (A-14) |

MATURITY LEVEL: Early Production [INFERRED]
FIT FOR PURPOSE: YES — a one-shot single-user terminal tool whose failure modes (cancel, cleanup, encoding, integrity, hangs) are now handled; what remains is change-safety and size.

PRIMARY RISKS: A-09 (new robustness code untested) · A-02 (adapter size) · A-01 (container size) · A-14 (watchdog false positive) · A-10 (CI unrun)
CRITICAL FINDINGS: none. HIGH: none.
DOCS-CODE DRIFT: no [FALSE] rows open (D-01..D-03 closed). D-04 [UNKNOWN].
REFACTOR URGENCY: **Next Quarter** for A-02/A-09; **Backlog** for the rest. Nothing blocks the stage; A-02 grew 28% in one change set and the roadmap's `--best` / `-o` / playlist items all touch `handlePick` and `download`, so the split is cheaper now than after them.

---

## Phase 7 — Roadmap

**IMMEDIATE (before next feature)**

- A-10 → put the folder under git, push, and confirm the first CI run is green on all 4 matrix cells → A-10 and A-11 drop from [UNKNOWN] to checked → S → SYSTEM → risk: Node 18 may expose a real incompatibility (that is the point).

**HIGH-IMPACT (next sprint)**

- A-14 → keep the watchdog off until the first `YOINK|` progress line or `[download] Destination:` line arrives, and set `processing` on any `[` post-processor line (e.g. `[Fixup`, `[Metadata`) → no false kill during extraction or post-processing → S → LOCAL → risk: a download that never prints would never be watchdogged; keep the 2-minute probe ceiling as the model.
- A-09 + A-02 (shared root: orchestration and provisioning code cannot be run without the network) → (1) move `withTimeout` to `lib/timeout.ts` and the provisioning set (`ensureYtDlp`, `checksumFor`, `updateIfStale`, `commandWorks`, `findFfmpeg`) to `lib/provision.ts`; (2) test `withTimeout` with fake timers (existing style: `node:test`, pure functions) → `ytdlp.ts` back under ~330 lines and the timeout helper covered → M → MODULE → risk: moderate, `app.tsx:20-32` imports need updating and `ytdlp.test.ts` imports `checksumFor`.

**LONG-TERM:** No target-state change warranted at this stage. The `app.tsx` split (a `useDownloadFlow` hook plus view components) becomes justified at the first trigger below.

**ACCEPTED DEBT (do not change now)**

- A-01: `app.tsx` is large but has one importer and no churn pressure until roadmap features land.
- A-03: single-slot `activeChild`; one download at a time today.
- A-04: probe→discard split is deliberate (comment at `app.tsx:214`) and backstopped on exit.
- A-05: one import of a tiny type guard.
- A-06: not reachable as an injection; fix together with the `--best` scriptable mode.
- A-11: leave until the first CI run reports.
- A-13: logging not worth a flag in a one-shot tool until reports arrive without detail.
- A-15: a same-origin checksum is the standard level for this class of tool; stronger verification needs signing keys that yt-dlp does not publish for the plain binary [UNKNOWN — confirm in yt-dlp docs].

**INTERACTION CHECK:** A-14 and A-09/A-02 both edit `download` / `ytdlp.ts`; do A-14 first (small, local), then the split, so the move does not carry a half-fixed watchdog. A-10 first of all, so every later change runs under CI.

**SWITCHING TRIGGERS**

- Roadmap `--best`/`--mp3`, `-o`, playlists land → unlocks the `app.tsx` split (A-01).
- A second contributor joins → unlocks lint boundary rules (dependency-cruiser) and CODEOWNERS.
- Concurrent downloads (playlists) → unlocks replacing `activeChild` with a registry (A-03).
- Bug reports without enough detail → unlocks A-13.

---

## Coverage block

**Surface audited:** `src/cli.tsx`, `src/app.tsx`, `src/theme.ts`, all of `src/lib/*` (plus the 2 test files and `ytdlp.test.ts`), `src/components/panel.tsx`, `fullscreen.tsx`, `shortcuts.tsx`, `progress-bar.tsx` (full); `text-input.tsx`, `framed-input.tsx`, `logo.tsx` (headers/imports only); `package.json`, `tsconfig.json`, `tsup.config.ts`, `.github/workflows/ci.yml`, `README.md`.
**Surface NOT audited:** bodies of `text-input.tsx` (198 lines), `framed-input.tsx`, `logo.tsx`; `package-lock.json`; `dist/`; `node_modules/`; yt-dlp itself. Reason: presentational/vendor, no architecture signal.
**Lenses applied:** Phases 1, 2, 3, 5, 6, 7. Phase 4 [N/A]. Conflict of interest: I wrote most of the code changed since the first audit (checksum, timeouts, parser extraction, CI); a second reviewer should read A-14, A-15 and the Failure-resilience score.
**Intent baseline basis:** [HYPOTHESIS] from the dominant detected pattern; all drift findings inherit this.
**Clean-claim scope:** Modules `components/*`, `history.ts`, `platforms.ts`, `format.ts`, `args.ts`, `use-mouse-click.ts`, `use-clipboard-url.ts`, `clipboard.ts`, `cli.tsx` were audited under lenses P1–P3 and P5 with no HIGH/CRITICAL finding; `app.tsx` and `ytdlp.ts` likewise have no HIGH/CRITICAL finding.
**Runtime-dependent set:** A-03 (interleaving), A-04 (SIGKILL leak), A-14 (watchdog on slow runs), A-11 (Node 18), and the Failure-resilience score itself (timeouts exist; none has been exercised against a dead connection). A CI run, a blackholed-network run and a slow-extraction run would resolve them.

**UNCERTAINTY ACKNOWLEDGMENT**

- Finding most likely a false positive: A-14 — yt-dlp prints a line early in extraction and progress lines continuously while downloading, so 90 s of silence may never occur on a healthy run.
- Real issue most likely missed: `text-input.tsx` (198 lines, paste auto-submit) was read for imports and headers only.
- Baseline claim most likely wrong: "layered UI → container → adapter" — intent was never written down; A-01 and A-02 depend on it.
- Cannot be determined statically: stall behavior, Node 18 compatibility, exit-handler ordering, CI results.
- Input that would most raise confidence: a first green CI run on all 4 cells, a captured set of yt-dlp stdout lines for slow/failed runs, and a one-paragraph intended-architecture statement from the author.
