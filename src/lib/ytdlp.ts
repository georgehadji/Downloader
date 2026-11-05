import {spawn, type ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream, rmSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[], timeout = 10_000): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** SHA-256 for `asset` from a release `SHA2-256SUMS` file (`<hex>  <name>` per line). */
export function checksumFor(sums: string, asset: string): string | undefined {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (name?.replace(/^\*/, '') === asset && /^[0-9a-f]{64}$/i.test(hash ?? '')) return hash!.toLowerCase()
  }
  return undefined
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) {
    await updateIfStale(local, onStatus)
    return local
  }

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})

  const asset = ytDlpAssetName()
  const tmp = `${local}.download`
  const limit = withTimeout(FETCH_TIMEOUT_MS, signal)
  try {
    // checksums first: fail before downloading ~18 MB we could not verify
    const sumsResponse = await fetch(`${RELEASE_BASE}/SHA2-256SUMS`, {signal: limit.signal})
    if (!sumsResponse.ok) {
      throw new Error(`Could not verify yt-dlp (${sumsResponse.status}). Check your connection and try again.`)
    }
    const expected = checksumFor(await sumsResponse.text(), asset)

    const response = await fetch(`${RELEASE_BASE}/${asset}`, {signal: limit.signal})
    if (!response.ok || !response.body) {
      throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
    }

    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal: limit.signal})
    const actual = createHash('sha256').update(await fs.readFile(tmp)).digest('hex')
    if (!expected || actual !== expected) {
      throw new Error('The downloaded yt-dlp failed its checksum check and was discarded. Try again.')
    }
    await fs.chmod(tmp, 0o755)
    await fs.rename(tmp, local)
  } catch (error) {
    // a cancelled or failed first run must not leave a truncated file behind
    await fs.rm(tmp, {force: true})
    if (limit.timedOut) throw new Error('Timed out fetching yt-dlp. Check your connection and try again.')
    throw error
  } finally {
    limit.clear()
  }
  return local
}

// shortcut: one flat ceiling for the whole fetch, so a very slow link (<~80 KB/s)
// fails; replace with a stall timer like download's if that ever bites
const FETCH_TIMEOUT_MS = 5 * 60 * 1000
const PROBE_TIMEOUT_MS = 2 * 60 * 1000

/** An AbortSignal that also fires after `ms`; `timedOut` tells the two causes apart. */
function withTimeout(ms: number, parent?: AbortSignal) {
  const controller = new AbortController()
  let timedOut = false
  const onParentAbort = () => controller.abort()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onParentAbort, {once: true})
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    clear() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

// sites change their players often, so an old yt-dlp stops working; the
// copy we downloaded is ours to keep fresh (a system install is not)
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

// shortcut: two concurrent -U possible if two probes race, serialize if it ever bites
async function updateIfStale(local: string, onStatus: (message: string) => void): Promise<void> {
  const {mtimeMs} = await fs.stat(local)
  if (Date.now() - mtimeMs < STALE_AFTER_MS) return
  onStatus('updating yt-dlp…')
  // -U verifies the release checksum and swaps the binary itself, even on Windows
  if (await commandWorks(local, ['-U'], 60_000)) {
    const now = new Date()
    await fs.utimes(local, now, now) // already-latest leaves mtime alone; restart the 7 days
  }
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it.
 */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return undefined
}

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

/**
 * Every yt-dlp process goes through here so its output is decoded the same
 * way: UTF-8 both ways. Without it Windows pipes use the ANSI code page and
 * non-ASCII titles come back as a path that doesn't exist.
 */
function spawnYtDlp(ytdlp: string, args: string[], signal?: AbortSignal): ChildProcess {
  const child = spawn(ytdlp, ['--encoding', 'utf-8', ...args], {signal})
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  return child
}

// info files this run wrote; the exit handler is the backstop for paths that
// never reach discardInfoJson (ctrl-c, crash)
const infoFiles = new Set<string>()
process.on('exit', () => {
  for (const file of infoFiles) {
    try {
      rmSync(file, {force: true})
    } catch {
      // EBUSY on Windows must not turn into an exit-time crash
    }
  }
})

export function discardInfoJson(file: string): Promise<void> {
  return fs.rm(file, {force: true}).then(
    () => void infoFiles.delete(file),
    () => {},
  )
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const limit = withTimeout(PROBE_TIMEOUT_MS, signal)
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawnYtDlp(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], limit.signal)
    let out = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: string) => (out += chunk))
    child.stderr!.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', error =>
      reject(limit.timedOut ? new Error('Timed out reading the video info. Check the link and your connection.') : error),
    )
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  }).finally(limit.clear)

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  infoFiles.add(infoJsonPath)
  // 0600: the info holds signed media urls, no reason for other users to read it
  await fs.writeFile(infoJsonPath, stdout, {mode: 0o600})
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

// title + id + height: two videos with the same title (or one video in two
// qualities) must not share a name, or yt-dlp skips the download and hands
// back the old file. The height part drops out for audio.
const OUTPUT_TEMPLATE = '%(title).60s [%(id)s]%(height& {}p|)s.%(ext)s'

/** Cached media urls expire; only these statuses mean "fetch fresh info and retry". */
export function isExpiredLinkError(error: unknown): boolean {
  return error instanceof Error && /HTTP Error (403|410)\b/.test(error.message)
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

export type ParseState = {
  part: number
  /** How many files this run resolves to (video+audio merges are 2). */
  totalParts: number
  lastDownloaded: number
  /** Final path, from `--print after_move:filepath`. */
  filepath: string
  /** Every file yt-dlp writes this run, so a cancel can clean up after itself. */
  destinations: string[]
}

export const newParseState = (): ParseState => ({
  part: 0,
  totalParts: 1,
  lastDownloaded: 0,
  filepath: '',
  destinations: [],
})

export type LineEvent = {kind: 'progress'; progress: DownloadProgress} | {kind: 'processing'} | undefined

/** Interpret one stdout line of a download run. Updates `state` in place; returns what the UI should hear about. */
export function parseDownloadLine(state: ParseState, rawLine: string): LineEvent {
  const line = rawLine.trim()
  if (!line) return undefined
  if (line.startsWith(PROGRESS_PREFIX)) {
    const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
    const downloadedBytes = toNumber(downloaded) ?? 0
    // the counter dropping means the next file (audio after video) started
    if (downloadedBytes < state.lastDownloaded) state.part++
    state.lastDownloaded = downloadedBytes
    return {
      kind: 'progress',
      progress: {
        downloadedBytes,
        totalBytes: toNumber(total) ?? toNumber(totalEstimate),
        speed: toNumber(speed),
        eta: toNumber(eta),
        part: state.part,
        totalParts: state.totalParts,
      },
    }
  }
  if (line.includes('Downloading 1 format(s):')) {
    // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
    state.totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
  } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
    const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
    const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
    const target = merging ?? extracting
    if (target) state.destinations.push(target)
    return {kind: 'processing'}
  } else if (line.startsWith('[download] Destination: ')) {
    state.destinations.push(line.slice('[download] Destination: '.length))
  } else if (path.isAbsolute(line)) {
    state.filepath = line
  }
  return undefined
}

// no output at all for this long while downloading means a dead connection;
// not applied once processing starts — ffmpeg can be silent for minutes
const STALL_MS = 90_000

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, OUTPUT_TEMPLATE),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawnYtDlp(opts.ytdlp, args, signal)
    activeChild = child

    const state = newParseState()
    let stderr = ''
    let buffer = ''
    let lastOutput = Date.now()
    let processing = false
    let stalled = false
    const watchdog = setInterval(() => {
      if (!processing && Date.now() - lastOutput > STALL_MS) {
        stalled = true
        child.kill()
      }
    }, 5_000)
    watchdog.unref()

    child.stdout!.on('data', (chunk: string) => {
      lastOutput = Date.now()
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseDownloadLine(state, line)
        if (event?.kind === 'progress') handlers.onProgress(event.progress)
        else if (event?.kind === 'processing') {
          processing = true
          handlers.onProcessing()
        }
      }
    })
    child.stderr!.on('data', (chunk: string) => {
      lastOutput = Date.now()
      stderr += chunk
    })
    child.on('error', error => {
      clearInterval(watchdog)
      reject(error)
    })
    child.on('close', code => {
      clearInterval(watchdog)
      activeChild = undefined
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind
        void removePartials(state.destinations)
        reject(new Error('Download cancelled.'))
        return
      }
      if (stalled) {
        // .part files stay: yt-dlp resumes from them on the next try
        reject(new Error(`Download stalled — no data for ${STALL_MS / 1000} s. Check your connection and try again.`))
        return
      }
      if (code === 0 && state.filepath) {
        resolve(state.filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      .map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
