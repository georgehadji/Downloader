# yoinks fix plan (audit of 0.3.1)

This plan fixes the 9 audit findings plus the 2 smaller findings the audit mentioned without detail.
It was written against this checkout, which matches the audited version (`6f03720`): every line number the audit cites matches the code here.

## Checked before writing this plan

- **Output template (#1, #2).** I ran yt-dlp 2026.10.26 offline on a fake info file with the title `日本語テスト ✓`, using the proposed template and `--encoding utf-8`:
  - video (`-f b`) gave `日本語テスト ✓ [vid123] 720p.mp4`
  - audio (`-f ba`) gave `日本語テスト ✓ [vid123].m4a` (after `-x`, this becomes `.mp3`)
- **Async clipboard read (#5).** Async `execFile('powershell', …)` with stdin left as an open pipe does not hang. It took 419 ms cold and 371 ms warm on this machine.
- **Not checked:** `npm test`, typecheck and build. `node_modules` is not installed in this checkout.

## Architecture and rules for every fix

| Layer | File | Role | Pattern to keep |
|---|---|---|---|
| Bootstrap | `src/cli.tsx` | Parses args, sets up the terminal, renders `App` | Keep it thin: no I/O that delays the first frame |
| UI | `src/app.tsx` | `Phase` union as a state machine, orchestration only | Phase transitions stay here. Knowledge of yt-dlp strings, files and processes stays out. |
| Hooks | `src/lib/use-*.ts` | Side effects with cleanup | `useEffect` + cleanup, same shape as `use-mouse-click.ts` |
| yt-dlp adapter | `src/lib/ytdlp.ts` | The only module that knows yt-dlp's CLI, output formats, error text and temp files | Anti-corruption layer: every fix that depends on how yt-dlp behaves goes here |
| Pure helpers | `src/lib/format.ts`, `click-map.ts`, `buildChoices` | Data transforms | Pure functions with `node:test` unit tests |

Rules this plan follows:

1. **Fix each root cause once, in the adapter.** `app.tsx` calls small exported functions like `isExpiredLinkError` and `discardInfoJson`. It never parses yt-dlp output and never touches `fs`.
2. **The module that creates a resource deletes it.** `ytdlp.ts` creates the info files, so `ytdlp.ts` tracks them and deletes them. An exit handler is a backstop (`ytdlp.ts:216` already uses this pattern for `activeChild`).
3. **Make side effects cancellable** with `AbortSignal`, as `probe`, `download` and `ensureYtDlp` already do.
4. **Put decisions in pure, tested functions.** The retry policy and the format menu are pure, so they get unit tests.
5. **No new dependencies.** Use the Node standard library (`node:util`, `node:fs`) and yt-dlp's own features (its output template syntax and its `-U` updater).

## Order of work

Each step is one commit. Run `npm test && npm run typecheck` after each one.

| # | Commit | Files | Why this position |
|---|---|---|---|
| 0 | Test `buildChoices` (#6) | `src/lib/ytdlp.test.ts` (new) | Gives a safety net before `ytdlp.ts` changes |
| 1 | Unique output names (#1) | `ytdlp.ts` | Silent wrong-file bug, highest severity |
| 2 | UTF-8 yt-dlp I/O (#2) | `ytdlp.ts` | Wrong path and leftover files on Windows |
| 3 | Delete info files and make them private (#4) | `ytdlp.ts`, `app.tsx` | Temp folder grows, privacy |
| 4 | Keep yt-dlp updated, clean up `.download` (#3, extra B) | `ytdlp.ts` | Downloads break after a few weeks |
| 5 | Retry only on expired links (#7) | `ytdlp.ts`, `app.tsx`, test | Misleading message, doubles the wait for real errors |
| 6 | Async clipboard after first frame (#5) | `clipboard.ts`, `use-clipboard-url.ts` (new), `app.tsx`, `cli.tsx` | Windows hint and startup time |
| 7 | Cleanups (#8, #9, extra A) | `click-map.ts`, `format.ts`, `app.tsx` | Removes code, no behavior change |

---

## Commit 0: test the format menu (#6)

**Pattern:** characterization test of a pure function. It pins the current behavior so later refactors can't change it unnoticed.

New file `src/lib/ytdlp.test.ts`, in the same style as `args.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {buildChoices, type VideoInfo} from './ytdlp.js'

const MB = 1024 * 1024

test('one row per height, tallest first, mp3 last', () => {
  const info: VideoInfo = {
    title: 't',
    formats: [
      {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, filesize: 20 * MB},
      {format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, filesize: 30 * MB},
      {format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, filesize: 5 * MB},
      {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 2 * MB},
    ],
  }
  assert.deepEqual(
    buildChoices(info).map(c => c.label),
    [
      '1080p · mp4 · ~22 MB', // video-only: avc mp4 wins, best audio size added
      '360p · mp4 · ~5.0 MB', // already has audio: own size only
      'audio only · mp3 · ~2.0 MB',
    ],
  )
})

test('no known heights falls back to best available', () => {
  const info: VideoInfo = {title: 't', formats: [{format_id: 'hls', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a'}]}
  assert.deepEqual(
    buildChoices(info).map(c => c.label),
    ['best available · mp4', 'audio only · mp3'],
  )
})
```

This test covers: dedup of two 1080p formats, the mp4/avc ranking (20 MB is chosen over 30 MB), adding the audio size to video-only formats, the muxed case, the fallback, and that the mp3 row comes last. Importing `ytdlp.ts` registers an exit handler, which does no harm in tests.

## Commit 1: a different video with the same title gives back the old file (#1), `ytdlp.ts:246-247`

**Root cause:** the output name is not unique per video or per resolution. yt-dlp sees that the file exists, skips the download, exits 0 and prints the old path.

**Design:** make the name unique with yt-dlp's own template language, in one place. Don't add a per-choice name field to `DownloadChoice`. The template's replacement syntax `%(height& {}p|)s` adds ` 720p` only when the chosen format has a height. So:

- video choices get the actual height, so a 1080p choice that falls back to 720p correctly reuses the 720p file.
- "best available" gets whatever height yt-dlp picks.
- mp3 gets no height suffix.

Do **not** use `--force-overwrites`. It would replace a different video's file, which loses data.

```ts
// title alone collides: another video with the same title, or another
// resolution of this one, was skipped as "already downloaded"
const OUTPUT_TEMPLATE = '%(title).60s [%(id)s]%(height& {}p|)s.%(ext)s'
…
    '-o',
    path.join(opts.outDir, OUTPUT_TEMPLATE),
```

**Side effect:** files saved by older versions (named without the id) are not reused, so they are downloaded once more. That is acceptable.

**Verify:** run the offline check from "Checked before writing this plan" again. Then do a real run: download 360p and then 1080p of the same video. You should get two files, and the second run should show a progress bar instead of finishing instantly.

## Commit 2: wrong path on Windows for non-ASCII titles (#2), `ytdlp.ts:231-265`

**Root cause:** on Windows, yt-dlp encodes its pipe output in the ANSI code page and drops characters it can't encode. Separately, `chunk.toString()` decodes each chunk on its own, so a multi-byte character split across two chunks gets garbled. This affects both `probe` (the `-J` output that is written to the info file, and the error text) and `download` (the final path, the `Destination:` lines used for cancel cleanup, and the error text).

**Design:** add a single spawn factory, so every yt-dlp process is decoded the same way:

```ts
// yt-dlp writes to pipes in the Windows ANSI code page and drops what it
// can't encode; force UTF-8 and decode across chunk boundaries
function spawnYtDlp(ytdlp: string, args: string[], signal?: AbortSignal) {
  const child = spawn(ytdlp, ['--encoding', 'utf-8', ...args], {signal})
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return child
}
```

- `probe` (L108): `const child = spawnYtDlp(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], signal)`.
- `download` (L252): `const child = spawnYtDlp(opts.ytdlp, args, signal)`. Change the handler to `(chunk: string) => { buffer += chunk …`.
- `commandWorks` is unchanged. It ignores stdio.

**Verify:** on Windows, download a video with emoji or CJK characters in its title. The done screen and the `✓ yoinked →` line should show a path that exists. Press esc during a download of such a video, and check that no `.part` file is left in `~/Downloads`.

## Commit 3: info files are never deleted (#4), `ytdlp.ts:130-131`, `app.tsx:190-192`

**Root cause:** `probe` creates a temp file and nothing owns deleting it. On Linux it is also created as world-readable (0644 with the default umask).

**Design:** the module that creates the file owns it. `ytdlp.ts` tracks every info file it writes, exports one function to release a file, and deletes any that remain on exit. `app.tsx` stays free of `fs`.

`ytdlp.ts`:

```ts
import {rmSync} from 'node:fs'
…
// info files still on disk — released by the app, swept on exit as a backstop
const infoFiles = new Set<string>()
process.on('exit', () => {
  for (const file of infoFiles) {
    try {
      rmSync(file, {force: true})
    } catch {
      // still open on Windows — nothing else to do this late
    }
  }
})

/** Delete a probe's info file once nothing will download from it again. */
export function discardInfoJson(file: string | undefined): void {
  if (!file) return
  void fs.rm(file, {force: true}).then(() => infoFiles.delete(file), () => {})
}
```

In `probe`:

```ts
  // 0600: it lists what the user looked at; tmp is shared on multi-user Linux
  await fs.writeFile(infoJsonPath, stdout, {mode: 0o600})
  infoFiles.add(infoJsonPath)
```

`app.tsx`: every path back to the input screen goes through `resetToInput`, including cancel, esc, ↵ after done or error, and the logo click. That makes it the single place to release the file:

```ts
  const resetToInput = useCallback(() => {
    discardInfoJson(infoJsonRef.current)
    infoJsonRef.current = undefined
    …
```

**Notes:**

- The `try/catch` in the exit handler is required. `rmSync` throws `EBUSY` on Windows if yt-dlp still has the file open, and an exception thrown inside an exit handler would crash on the way out.
- A probe cancelled after it wrote its file never stores that path in `infoJsonRef`. The exit backstop deletes that file.
- If the process is killed by a signal, exit handlers don't run, so the file stays. Ctrl+C is not affected: ink handles it in raw mode and exits normally.

**Verify:** paste three links one after another, then quit. `ls $TMPDIR/yoinks-info-*` (or `%TEMP%` on Windows) should be empty. On Linux, `stat` a file during the picking screen and check that its mode is `-rw-------`.

## Commit 4: the downloaded yt-dlp never updates (#3), `ytdlp.ts:42-58`, and the leftover `.download` file (extra B)

**Root cause:** the cached binary is used forever.

**Design:** use yt-dlp's own updater (`-U`) instead of downloading the binary again ourselves:

- It checks SHA-256 checksums. The current `fetch` path does not.
- It replaces the binary safely on Windows.
- It reuses `commandWorks`, which has a timeout.
- It completes the README roadmap item "Self-update for the bundled yt-dlp binary (`yt-dlp -U`)".

The first download keeps using the existing `fetch` code. The system `yt-dlp` on PATH is never touched, because the user manages it.

```ts
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

function commandWorks(cmd: string, args: string[], timeout = 10_000): Promise<boolean> {
  … spawn(cmd, args, {stdio: 'ignore', timeout}) …
}

export async function ensureYtDlp(onStatus, signal) {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = …
  if (await commandWorks(local, ['--version'])) {
    // sites break old yt-dlp within weeks
    if (Date.now() - (await fs.stat(local)).mtimeMs > STALE_AFTER_MS) {
      onStatus('updating yt-dlp…')
      // -U leaves the file alone when it's already current, so touch it to restart
      // the clock; a failed update keeps the old copy and retries next run
      if (await commandWorks(local, ['-U'], 60_000)) await fs.utimes(local, new Date(), new Date())
    }
    return local
  }

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})
  …
  const tmp = `${local}.download`
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
    await fs.chmod(tmp, 0o755)
    await fs.rename(tmp, local)
  } catch (error) {
    // cancelled or failed mid-download — don't leave a partial binary behind
    await fs.rm(tmp, {force: true})
    throw error
  }
  return local
}
```

**Edge cases:**

- **Offline:** `-U` fails fast. yoinks keeps the old copy and tries again next run.
- **Very slow network:** the 60 s timeout kills `-U`. yt-dlp downloads the update to a temp file first, so the old binary stays intact.
- **Esc during "updating yt-dlp…":** the UI resets right away. `-U` finishes in the background, and `startProbe` already checks `signal.aborted` afterwards.
- **Known limit:** if the user starts a new probe while that `-U` is still running, a second `-U` can start in parallel. This is rare and harmless: both replace the binary atomically. Add a comment `shortcut: two concurrent -U possible, memoize ensureYtDlp if it ever matters`.

**Verify:** set the binary's mtime back 8 days (`touch -d '8 days ago' ~/.yoinks/bin/yt-dlp*`) with no `yt-dlp` on PATH (hide the system one, for example by running with a reduced `PATH`). Run yoinks and check that "updating yt-dlp…" appears and the mtime becomes today. Run again: no update step. Then set the mtime back again and run offline: the probe still works with the old copy. To check the `.download` cleanup, delete `~/.yoinks/bin`, start yoinks, press esc during "first run: fetching yt-dlp…", and check that there is no `yt-dlp*.download` file.

## Commit 5: every failed download is retried (#7), `app.tsx:264-274`

**Root cause:** the app retries on every error, and it shows "link expired" each time.

**Design:** retrying is a policy decision based on yt-dlp's error text, so the check belongs in the adapter as a pure, tested function. The app only reads the yes/no answer.

`ytdlp.ts`:

```ts
/** Media urls cached in the info file expire (403/410) — the one failure a fresh extraction fixes. */
export function isExpiredLinkError(error: unknown): boolean {
  return error instanceof Error && /HTTP Error (403|410)\b/.test(error.message)
}
```

`app.tsx` L268:

```ts
          // only a fresh extraction can fix expired media urls; any other error is final
          if (controller.signal.aborted || !infoJsonRef.current || !isExpiredLinkError(error)) throw error
```

The `!infoJsonRef.current` check skips a pointless second attempt when the first one already used a fresh extraction.

Add to `ytdlp.test.ts`:

```ts
test('only expired-link errors are worth a fresh extraction', () => {
  assert.equal(isExpiredLinkError(new Error('unable to download video data: HTTP Error 403: Forbidden')), true)
  assert.equal(isExpiredLinkError(new Error('HTTP Error 410: Gone')), true)
  assert.equal(isExpiredLinkError(new Error('No space left on device')), false)
  assert.equal(isExpiredLinkError(new Error('HTTP Error 404: Not Found')), false)
})
```

The messages above are what `cleanYtDlpError` returns: it strips the `ERROR: [extractor]` prefix and keeps the `HTTP Error NNN` text.

**Known limit:** a 403 caused by a region block also gets one retry. That costs one extra attempt and doesn't hurt.

## Commit 6: clipboard check times out on a cold start and delays the first frame (#5), `clipboard.ts:7-17`, `cli.tsx:56-62`

**Root cause:** `execFileSync` with a 500 ms timeout runs before `render`. A cold PowerShell start took 520 ms in the audit and 419 ms here, so it times out on some starts and delays the first frame on all of them.

**Design:** make the read async and cancellable, and own it with a React effect that runs after the first commit, so the first frame is drawn before the clipboard is read. This follows the `use-mouse-click.ts` hook pattern. The URL check moves out of `cli.tsx` and into the hook, together with the read.

`src/lib/clipboard.ts`:

```ts
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const run = promisify(execFile)
…
/** Clipboard text, or '' when no clipboard tool works. */
export async function readClipboard(signal?: AbortSignal): Promise<string> {
  for (const [command, args] of COMMANDS) {
    try {
      // a cold PowerShell start alone takes ~0.5 s
      return (await run(command, args, {encoding: 'utf8', timeout: 2000, signal})).stdout
    } catch {
      if (signal?.aborted) return ''
      // tool missing or clipboard empty — try the next one
    }
  }
  return ''
}
```

Also add `'-NonInteractive'` to the PowerShell args.

New file `src/lib/use-clipboard-url.ts`:

```ts
import {useEffect, useState} from 'react'
import {readClipboard} from './clipboard.js'
import {isProbablyUrl} from './platforms.js'

/** A url sitting in the clipboard, read after the first frame so startup never waits on it. */
export function useClipboardUrl(enabled: boolean): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void readClipboard(controller.signal).then(text => {
      const clipped = text.trim()
      // reject multi-line clipboard content — new URL() silently strips newlines
      if (clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) setUrl(clipped)
    })
    return () => controller.abort()
  }, [enabled])
  return url
}
```

`app.tsx`:

- Remove `clipboardUrl` from `AppProps` and from `AppContent`'s props.
- In `AppContent`, add: `const clipboardUrl = useClipboardUrl(!initialUrl && Boolean(process.stdout.isTTY))`. `App` already reads `process.stdin.isTTY` directly at L232.
- The `clipboardOffered` and `clipboardAccepted` logic stays as it is. If the user starts typing before the read finishes, `urlInput !== ''` already hides the hint.

`cli.tsx`: delete L56–62, the `clipboardUrl` prop, and the now unused imports `readClipboard` and `isProbablyUrl`.

**Known UX limit:** the hint row appears about 0.4 s after the first frame, which moves the centered layout by one row. That is accepted. If it looks bad, render `<Text> </Text>` in place of `null` in the input phase, so the row is always there.

**Verify:** on Windows, copy a URL and start `yoinks` five times. The hint should appear every time, and the logo should draw at once. Copy text that has spaces in it: no hint should appear. Start `yoinks <url>`: no PowerShell process should start (check with Task Manager or `Get-Process powershell`).

## Commit 7: cleanups (#8, #9, extra A)

**#8 `click-map.ts:8-16`.** Delete `ANSI_PATTERN` and the `stripAnsi` arrow. Add:

```ts
import {stripVTControlCharacters as stripAnsi} from 'node:util'
```

Node's pattern also covers everything the old one did, including OSC strings ended by BEL or ST. `engines` is `>=18`, and this function exists since Node 16.11. No new test is needed: it is a standard-library swap, and the click check below covers it.

**#9 `format.ts:60-63`.** Delete `formatEta`. In `app.tsx:76`, use `formatDuration(progress.eta)` and remove `formatEta` from the import on L15. `formatDuration` already has the same finite and `<= 0` guard, so the output is identical.

**Extra A: the "esc means back" rule is in three places** (`app.tsx` L228–229, L296, L329–330). Turn it into one derived value:

```ts
  // esc, its hint and the logo all mean "back": cancel a running job, else go home
  const goBack = phase.name === 'probing' || phase.name === 'downloading' ? cancelRun : resetToInput
```

- `useInput`: `if (key.escape && phase.name !== 'input') goBack()`
- `hintAction`: `if (key === 'esc') return goBack`
- logo click: `if (phase.name !== 'input') goBack()`, then `return`

The behavior is identical to today's three rules. Esc in the input phase still does nothing.

**Verify:** click every button and hint in each phase, and press esc in each phase.

---

## Final checks (after commit 7)

```bash
npm install
npm test
npm run typecheck
npm run build
```

Manual checks with a real network connection:

| Case | Windows | macOS/Linux |
|---|---|---|
| Two Instagram reels from the same user ("Video by …") give two files | ✓ | ✓ |
| 360p, then 1080p of the same video, gives two files | ✓ | ✓ |
| Emoji/CJK title: path shown exists; esc leaves no `.part` | ✓ (main target) | ✓ |
| Three links pasted, then quit: no `yoinks-info-*` left in temp | ✓ | ✓ (also mode 0600) |
| Clipboard hint appears on a cold start | ✓ (main target) | ✓ |
| Stale yt-dlp copy gets updated; offline still works | ✓ | ✓ |

## Out of scope

- Auto-updating a `yt-dlp` the user installed on PATH. They manage that copy.
- Checksum verification for the first-run `fetch`. It would be worth doing, but it is a separate change.
- Memoizing `ensureYtDlp` to stop parallel `-U` runs.
- Reading the UI components and `theme.ts`, which the audit didn't read either.

## Expected size

About +60 lines and −35 lines, roughly half of it tests. No new dependencies. Two new files: `src/lib/ytdlp.test.ts` and `src/lib/use-clipboard-url.ts`.
