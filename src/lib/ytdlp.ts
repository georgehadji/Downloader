import {spawn, type ChildProcess} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {debug} from './debug.js'
import {formatBytes, stripControlChars} from './format.js'
import {saveInfoJson, sweepStaleInfoFiles} from './info-files.js'
import {withTimeout} from './timeout.js'

const PROBE_TIMEOUT_MS = 2 * 60 * 1000

export type VideoInfo = {
  /** 'playlist' when the link names a whole list rather than one video. */
  _type?: string
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
  debug(`spawn ${ytdlp} ${args.join(' ')}`)
  const child = spawn(ytdlp, ['--encoding', 'utf-8', ...args], {signal})
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  if (process.platform === 'win32' && child.pid) {
    // the standalone yt-dlp.exe is a launcher with the real yt-dlp as its child; killing
    // only the launcher leaves that child holding our pipes, so 'close' never fires
    const pid = String(child.pid)
    const killLauncher = child.kill.bind(child)
    child.kill = () => {
      spawn('taskkill', ['/pid', pid, '/T', '/F'], {stdio: 'ignore'}).on('error', () => killLauncher())
      return true
    }
  }
  return child
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  void sweepStaleInfoFiles()
  const limit = withTimeout(PROBE_TIMEOUT_MS, signal)
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawnYtDlp(ytdlp, ['-J', '--no-playlist', '--flat-playlist', '--no-warnings', url], limit.signal)
    let out = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: string) => (out += chunk))
    child.stderr!.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', error =>
      reject(limit.timedOut ? new Error('Timed out reading the video info. Check the link and your connection.') : error),
    )
    child.on('close', code => {
      debug(`probe exit ${code}\n${stderr}`)
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

  return {info, infoJsonPath: await saveInfoJson(stdout)}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

/** What `--best` downloads: the highest quality, merged to mp4. Needs no probe. */
export const BEST_CHOICE: DownloadChoice = {
  kind: 'video',
  label: 'best available · mp4',
  args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
}

const MP3_ARGS = ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']

/** What `--mp3` downloads. */
export const MP3_CHOICE: DownloadChoice = {kind: 'audio', label: 'audio only · mp3', args: MP3_ARGS}

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

  if (choices.length === 0) choices.push(BEST_CHOICE)

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({...MP3_CHOICE, label: `audio only · mp3${audioSizeLabel}`})

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
  /** Called with each finished file — a playlist run yields many. */
  onFile?: (filepath: string) => void
  /** A playlist run finished with some videos failed; the others still landed. */
  onWarning?: (message: string) => void
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

/** Where a run is, which decides how much silence from yt-dlp is normal. */
export type RunPhase = 'preparing' | 'downloading' | 'processing'

export type ParseState = {
  phase: RunPhase
  part: number
  /** How many files this run resolves to (video+audio merges are 2). */
  totalParts: number
  lastDownloaded: number
  /** Last final path, from `--print after_move:filepath`. */
  filepath: string
  /** Every final path so far — a playlist run prints one per video. */
  filepaths: string[]
  /** Every file yt-dlp writes this run, so a cancel can clean up after itself. */
  destinations: string[]
}

export const newParseState = (): ParseState => ({
  phase: 'preparing',
  part: 0,
  totalParts: 1,
  lastDownloaded: 0,
  filepath: '',
  filepaths: [],
  destinations: [],
})

export type LineEvent =
  | {kind: 'progress'; progress: DownloadProgress}
  | {kind: 'processing'}
  | {kind: 'file'; filepath: string}
  | undefined

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
    state.phase = 'downloading'
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
    state.phase = 'processing'
    return {kind: 'processing'}
  } else if (line.startsWith('[download] Destination: ')) {
    state.destinations.push(line.slice('[download] Destination: '.length))
    state.phase = 'downloading'
  } else if (POST_PROCESSOR.test(line)) {
    // ffmpeg work yt-dlp doesn't narrate; the UI keeps showing the download bar
    state.phase = 'processing'
  } else if (path.isAbsolute(line)) {
    state.filepath = line
    state.filepaths.push(line)
    return {kind: 'file', filepath: line}
  }
  return undefined
}

const POST_PROCESSOR =
  /^\[(Fixup\w*|Metadata|EmbedSubtitle|EmbedThumbnail|VideoConvertor|VideoRemuxer|ThumbnailsConvertor|SubtitlesConvertor|ModifyChapters|SponsorBlock|SplitChapters|MoveFiles)\]/

// how long yt-dlp may stay silent before we call the run dead: short once
// bytes should be flowing, longer while it extracts, never while ffmpeg works
// (post-processing can be silent for minutes)
const SILENCE_LIMIT_MS: Record<RunPhase, number> = {
  preparing: 2 * 60 * 1000,
  downloading: 90_000,
  processing: Infinity,
}

const activeChildren = new Set<ChildProcess>()
process.on('exit', () => {
  for (const child of activeChildren) child.kill('SIGTERM')
})

export type DownloadOptions = {
  ytdlp: string
  ffmpegLocation?: string
  url: string
  /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
  infoJsonPath?: string
  choice: DownloadChoice
  outDir: string
  /** Download every video of a playlist link instead of just the one. */
  playlist?: boolean
  /** Test seam: replaces the 90 s silence limit of the downloading phase. */
  silenceLimitMs?: number
}

export function downloadArgs(opts: DownloadOptions): string[] {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    opts.playlist ? '--yes-playlist' : '--no-playlist',
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
    // a literal % in the folder name must not start a template field (%% is a literal %)
    path.join(opts.outDir.replaceAll('%', '%%'), OUTPUT_TEMPLATE),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)
  return args
}

export function download(opts: DownloadOptions, handlers: DownloadHandlers, signal?: AbortSignal): Promise<string> {
  const args = downloadArgs(opts)

  return new Promise((resolve, reject) => {
    const child = spawnYtDlp(opts.ytdlp, args, signal)
    activeChildren.add(child)

    const state = newParseState()
    let stderr = ''
    let buffer = ''
    let lastOutput = Date.now()
    let stalledAfterMs = 0
    const watchdog = setInterval(() => {
      const limit = state.phase === 'downloading' && opts.silenceLimitMs ? opts.silenceLimitMs : SILENCE_LIMIT_MS[state.phase]
      if (!stalledAfterMs && Date.now() - lastOutput > limit) {
        stalledAfterMs = limit
        child.kill()
      }
    }, opts.silenceLimitMs ? Math.max(20, opts.silenceLimitMs / 4) : 5_000)
    watchdog.unref()

    child.stdout!.on('data', (chunk: string) => {
      lastOutput = Date.now()
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseDownloadLine(state, line)
        if (event?.kind === 'progress') handlers.onProgress(event.progress)
        else if (event?.kind === 'processing') handlers.onProcessing()
        else if (event?.kind === 'file') handlers.onFile?.(event.filepath)
      }
    })
    child.stderr!.on('data', (chunk: string) => {
      lastOutput = Date.now()
      stderr += chunk
    })
    child.on('error', error => {
      clearInterval(watchdog)
      activeChildren.delete(child)
      // spawn's abort signal reports as an AbortError; say what actually happened
      reject(signal?.aborted ? new Error('Download cancelled.') : error)
    })
    child.on('close', code => {
      clearInterval(watchdog)
      activeChildren.delete(child)
      debug(`download exit ${code}\n${stderr}`)
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind
        // a playlist run has finished videos among its destinations — those stay
        void removePartials(state.destinations.filter(file => !state.filepaths.includes(file)))
        reject(new Error('Download cancelled.'))
        return
      }
      if (stalledAfterMs) {
        // .part files stay: yt-dlp resumes from them on the next try
        reject(new Error(`Download stalled — no data for ${stalledAfterMs / 1000} s. Check your connection and try again.`))
        return
      }
      // yt-dlp exits 1 when any playlist entry fails; the files that did land still count
      if (state.filepath && (code === 0 || opts.playlist)) {
        if (code !== 0) handlers.onWarning?.(cleanYtDlpError(stderr) || `some videos failed (yt-dlp exit code ${code})`)
        resolve(state.filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

/** Download from the probe's cached info; if its media links have expired (403/410), extract fresh once. */
export async function downloadWithRefresh(
  opts: DownloadOptions,
  handlers: DownloadHandlers & {onRefresh?: () => void},
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await download(opts, handlers, signal)
  } catch (error) {
    if (signal?.aborted || !opts.infoJsonPath || !isExpiredLinkError(error)) throw error
    handlers.onRefresh?.()
    return download({...opts, infoJsonPath: undefined}, handlers, signal)
  }
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      // ffmpeg may still hold the file for a moment after a cancel; retry on EBUSY/EPERM
      .map(file => fs.rm(file, {force: true, maxRetries: 5, retryDelay: 100})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

export function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  // the text can carry website-supplied escape sequences; scripted mode prints it raw
  return last ? stripControlChars(last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')) : ''
}
