import assert from 'node:assert/strict'
import {createHash, generateKeyPairSync} from 'node:crypto'
import cp from 'node:child_process'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {TRUSTED_KEYS} from './release-signature.js'
import {signDetached} from './sign-for-test.js'

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-update-'))
process.env.YOINKS_BIN_DIR = binDir
process.env.PATH = '' // the stand-in below is the only yt-dlp
const local = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

const asset =
  process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
const OLD = 'old stand-in'
const NEW = 'new stand-in'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const signer = generateKeyPairSync('rsa', {modulusLength: 2048})
const fingerprint = '34'.repeat(20)
TRUSTED_KEYS.push({fingerprint, key: signer.publicKey})

// what the release currently offers, and what the network does
let latest = NEW
let releaseDown = false
let hang = false
const fetched: string[] = []
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const name = String(url).split('/').pop()!
  fetched.push(name)
  if (hang) {
    await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
  }
  if (releaseDown) return new Response('nope', {status: 500})
  const sums = Buffer.from(`${sha(latest)}  ${asset}\n`)
  if (name === 'SHA2-256SUMS') return new Response(sums)
  if (name === 'SHA2-256SUMS.sig') return new Response(new Uint8Array(signDetached(sums, signer.privateKey, fingerprint)))
  return new Response(latest)
}) as typeof fetch

// no real processes: the installed stand-in and a freshly downloaded `*.download` file both "run"
cp.spawn = ((cmd: string) => {
  const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter()})
  setImmediate(() => (cmd === local || cmd.endsWith('.download') ? child.emit('close', 0) : child.emit('error', new Error('ENOENT'))))
  return child
}) as unknown as typeof cp.spawn
syncBuiltinESMExports()
const {ensureYtDlp} = await import('./provision.js')

const DAY = 24 * 60 * 60 * 1000
const setAge = (days: number) => {
  const when = new Date(Date.now() - days * DAY)
  fs.utimesSync(local, when, when)
}
const ageMs = () => Date.now() - fs.statSync(local).mtimeMs
const content = () => fs.readFileSync(local, 'utf8')

test.beforeEach(() => {
  fs.writeFileSync(local, OLD)
  latest = NEW
  releaseDown = false
  hang = false
  fetched.length = 0
})

test('a copy older than 7 days is replaced by the newer verified release, and its age restarts', async () => {
  setAge(10)
  assert.equal(await ensureYtDlp(() => {}), local)
  assert.equal(content(), NEW)
  assert.ok(ageMs() < 60_000)
  assert.equal(fs.readdirSync(binDir).length, 1) // no temp file left behind
})

test('a fresh copy is left alone', async () => {
  setAge(1)
  await ensureYtDlp(() => {})
  assert.deepEqual(fetched, [])
  assert.equal(content(), OLD)
})

test('an up-to-date copy costs only the sums and signature, and its age restarts', async () => {
  latest = OLD
  setAge(10)
  await ensureYtDlp(() => {})
  assert.deepEqual(fetched.sort(), ['SHA2-256SUMS', 'SHA2-256SUMS.sig'])
  assert.equal(content(), OLD)
  assert.ok(ageMs() < 60_000)
})

test('a failed update retries in a day, not on every launch', async () => {
  setAge(10)
  releaseDown = true
  assert.equal(await ensureYtDlp(() => {}), local) // a failed update must not break the run
  assert.equal(content(), OLD)
  // about 6 days old (timestamp rounding makes the edge fuzzy): not stale yet, stale again in a day
  assert.ok(ageMs() > 5.9 * DAY && ageMs() < 7 * DAY, `age was ${ageMs() / DAY} days`)
  fetched.length = 0
  await ensureYtDlp(() => {})
  assert.deepEqual(fetched, []) // the next launch skips the update
})

test('Esc during the update stops it at once and leaves the old copy alone', async () => {
  setAge(10)
  hang = true
  const controller = new AbortController()
  const running = ensureYtDlp(() => {}, controller.signal)
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(running)
  assert.equal(content(), OLD)
  assert.ok(ageMs() > 9.9 * DAY) // still stale, so the next launch tries again
  fs.rmSync(binDir, {recursive: true, force: true})
})
