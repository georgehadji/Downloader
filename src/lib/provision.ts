import {spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {TRUSTED_KEYS, verifyDetachedSignature} from './release-signature.js'
import {withTimeout} from './timeout.js'

// env override exists so tests can install into a temp dir instead of the real home
const YOINKS_DIR = process.env.YOINKS_BIN_DIR ?? path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

/** The standalone release binary for this machine, or undefined when the release has none (e.g. 32-bit ARM ships only a zip). */
function ytDlpAssetName(): string | undefined {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64'
  return process.arch === 'x64' ? 'yt-dlp_linux' : undefined
}

const INSTALL_YOURSELF = 'Install yt-dlp yourself (for example: pip install yt-dlp) and try again.'

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
/** stdout of a command that exited 0, or undefined if it failed to start, timed out or exited non-zero. */
function commandOutput(cmd: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'ignore'], timeout})
    } catch {
      resolve(undefined)
      return
    }
    let output = ''
    child.stdout?.on('data', chunk => (output += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve(code === 0 ? output : undefined))
  })
}

const commandWorks = async (cmd: string, args: string[]) => (await commandOutput(cmd, args)) !== undefined

/** SHA-256 for `asset` from a release `SHA2-256SUMS` file (`<hex>  <name>` per line). */
export function checksumFor(sums: string, asset: string): string | undefined {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (name?.replace(/^\*/, '') === asset && /^[0-9a-f]{64}$/i.test(hash ?? '')) return hash!.toLowerCase()
  }
  return undefined
}

// a system yt-dlp older than this is replaced by our own fresh copy: sites change
// their players often, and a distro package can be a year behind
const SYSTEM_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

/** yt-dlp versions are release dates (2026.10.26, nightlies add .123456). Unreadable → not outdated, so a user's own build is kept. */
export function isOutdated(version: string, now = Date.now()): boolean {
  const date = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version.trim())
  return date ? now - Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!) > SYSTEM_MAX_AGE_MS : false
}

/**
 * Resolve a usable yt-dlp binary: a current system install first, then our own
 * managed copy (downloaded and kept fresh), which also replaces an old system install.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const systemVersion = await commandOutput('yt-dlp', ['--version'])
  if (systemVersion !== undefined && !isOutdated(systemVersion)) return 'yt-dlp'
  try {
    return await ensureManagedYtDlp(onStatus, signal)
  } catch (error) {
    if (systemVersion === undefined || signal?.aborted) throw error
    onStatus(`using your yt-dlp ${systemVersion.trim()} — it's old, so some sites may fail`)
    return 'yt-dlp'
  }
}

async function ensureManagedYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const asset = ytDlpAssetName()
  if (await commandWorks(local, ['--version'])) {
    if (asset) await updateIfStale(local, asset, onStatus, signal)
    return local
  }

  if (!asset) throw new Error(`yt-dlp has no download for this system (${process.platform}/${process.arch}). ${INSTALL_YOURSELF}`)

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})
  try {
    await withFetchLimit(signal, async limit => installRelease(local, asset, await fetchExpectedHash(asset, limit), limit))
  } catch (error) {
    // another Yoinks installed it first (on Windows the rename fails while that copy runs): use theirs
    if (await commandWorks(local, ['--version'])) return local
    throw error
  }
  return local
}

// shortcut: one flat ceiling for the whole fetch, so a very slow link (<~80 KB/s)
// fails; replace with a stall timer like download's if that ever bites
const FETCH_TIMEOUT_MS = 5 * 60 * 1000

async function withFetchLimit<T>(signal: AbortSignal | undefined, work: (limit: AbortSignal) => Promise<T>): Promise<T> {
  const limit = withTimeout(FETCH_TIMEOUT_MS, signal)
  try {
    return await work(limit.signal)
  } catch (error) {
    if (limit.timedOut) throw new Error('Timed out fetching yt-dlp. Check your connection and try again.')
    throw error
  } finally {
    limit.clear()
  }
}

async function fetchRelease(name: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`${RELEASE_BASE}/${name}`, {signal})
  if (!response.ok) throw new Error(`Could not fetch yt-dlp’s ${name} (${response.status}). Check your connection and try again.`)
  return response
}

/** The release's SHA2-256SUMS text, but only if yt-dlp's signature over it checks out against a key we ship. */
async function fetchVerifiedSums(signal: AbortSignal): Promise<string> {
  const [sums, sig] = await Promise.all(
    ['SHA2-256SUMS', 'SHA2-256SUMS.sig'].map(async name => Buffer.from(await (await fetchRelease(name, signal)).arrayBuffer())),
  )
  if (!verifyDetachedSignature(sums!, sig!, TRUSTED_KEYS)) {
    throw new Error(`yt-dlp’s release signature didn’t check out. ${INSTALL_YOURSELF}`)
  }
  return sums!.toString('utf8')
}

/** The verified SHA-256 of `asset` in the latest release. Checked before downloading ~18 MB we could not trust. */
async function fetchExpectedHash(asset: string, signal: AbortSignal): Promise<string> {
  const expected = checksumFor(await fetchVerifiedSums(signal), asset)
  if (!expected) throw new Error(`yt-dlp’s release does not list ${asset}. ${INSTALL_YOURSELF}`)
  return expected
}

const sha256File = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex')

/** Download `asset`, require the verified hash, prove it runs, then move it over `local`. Leaves nothing behind on failure. */
async function installRelease(local: string, asset: string, expected: string, signal: AbortSignal): Promise<void> {
  // unique, so two first runs at once never write the same file
  // shortcut: a hard kill mid-download leaves a stray *.download file; sweep old ones if they ever pile up
  const tmp = `${local}.${process.pid}-${randomUUID()}.download`
  try {
    const response = await fetchRelease(asset, signal)
    if (!response.body) throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
    if ((await sha256File(tmp)) !== expected) {
      throw new Error('The downloaded yt-dlp failed its checksum check and was discarded. Try again.')
    }
    await fs.chmod(tmp, 0o755)
    // a binary this system can't run (musl, wrong arch) would otherwise be re-downloaded on every launch
    if (!(await commandWorks(tmp, ['--version']))) {
      throw new Error(`The downloaded yt-dlp can’t run on this system. ${INSTALL_YOURSELF}`)
    }
    await fs.rename(tmp, local)
  } finally {
    // a cancelled or failed run must not leave a truncated file behind
    await fs.rm(tmp, {force: true})
  }
}

// the copy we manage is ours to keep fresh (a system install is not)
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000

// shortcut: two concurrent updates possible if two launches race, serialize if it ever bites
async function updateIfStale(local: string, asset: string, onStatus: (message: string) => void, signal?: AbortSignal): Promise<void> {
  const {mtimeMs} = await fs.stat(local)
  if (Date.now() - mtimeMs < STALE_AFTER_MS) return
  onStatus('checking for a yt-dlp update…')
  let stamp = new Date()
  try {
    await withFetchLimit(signal, async limit => {
      const expected = await fetchExpectedHash(asset, limit)
      // an up-to-date copy costs ~2 KB (sums + signature), not 18 MB
      if (expected !== (await sha256File(local))) await installRelease(local, asset, expected, limit)
    })
  } catch (error) {
    if (signal?.aborted) throw error // Esc: stop right away and leave the old copy alone
    // offline, rate-limited or the file is locked by another window: retry in a day, not on every launch
    stamp = new Date(Date.now() - STALE_AFTER_MS + RETRY_AFTER_MS)
  }
  await fs.utimes(local, stamp, stamp)
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
