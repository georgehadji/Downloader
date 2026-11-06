import {formatSpeed} from './format.js'
import {ensureYtDlp, findFfmpeg} from './provision.js'
import {BEST_CHOICE, download, MP3_CHOICE, type DownloadProgress} from './ytdlp.js'

export type HeadlessOptions = {
  ytdlp: string
  ffmpegLocation?: string
  url: string
  /** mp3 instead of the best video. */
  audio: boolean
  /** every video of a playlist link, not just one. */
  playlist: boolean
  outDir: string
}

export type HeadlessReport = {
  files: string[]
  /** Set when a playlist finished with some videos failed. */
  warning?: string
}

/** One short line for a terminal's status row, e.g. `42%  1.3 MiB/s`. */
export function formatProgress(progress: DownloadProgress): string {
  const percent = progress.totalBytes ? `${Math.floor((progress.downloadedBytes / progress.totalBytes) * 100)}%` : ''
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return [percent, speed].filter(Boolean).join('  ')
}

/** The scriptable path: no picker, no UI — fetch the best video or the mp3 and report the files. */
export async function yoinkHeadless(
  opts: HeadlessOptions,
  onProgress: (progress: DownloadProgress) => void = () => {},
  signal?: AbortSignal,
): Promise<HeadlessReport> {
  const files: string[] = []
  let warning: string | undefined
  const last = await download(
    {
      ytdlp: opts.ytdlp,
      ffmpegLocation: opts.ffmpegLocation,
      url: opts.url,
      choice: opts.audio ? MP3_CHOICE : BEST_CHOICE,
      outDir: opts.outDir,
      playlist: opts.playlist,
    },
    {
      onProgress,
      onProcessing: () => {},
      onFile: file => files.push(file),
      onWarning: message => (warning = message),
    },
    signal,
  )
  if (files.length === 0) files.push(last)
  return {files, warning}
}

export type HeadlessIo = {
  /** One saved file path per call — the only thing that goes to stdout. */
  out: (line: string) => void
  /** Raw text for stderr: status lines, progress, errors. */
  err: (text: string) => void
  /** Whether stderr is a terminal, which decides if progress is drawn. */
  isTTY: boolean
}

/** The whole scriptable run: provision, download, report. Returns the exit code instead of exiting. */
export async function runHeadless(
  request: Omit<HeadlessOptions, 'ytdlp' | 'ffmpegLocation'>,
  io: HeadlessIo,
  signal: AbortSignal,
): Promise<number> {
  try {
    const ytdlp = await ensureYtDlp(message => io.err(`${message}\n`), signal)
    const report = await yoinkHeadless(
      {...request, ytdlp, ffmpegLocation: await findFfmpeg()},
      progress => io.isTTY && io.err(`\r\x1b[K${formatProgress(progress)}`),
      signal,
    )
    if (io.isTTY) io.err('\r\x1b[K')
    for (const file of report.files) io.out(file)
    if (report.warning) {
      io.err(`yoinks: ${report.warning}\n`)
      return 1
    }
    return 0
  } catch (error) {
    if (io.isTTY) io.err('\r\x1b[K')
    io.err(`yoinks: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
