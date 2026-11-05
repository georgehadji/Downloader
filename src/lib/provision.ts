import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {withTimeout} from './timeout.js'

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
