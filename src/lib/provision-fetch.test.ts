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

// each test file runs in its own process, so these globals are ours alone
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-bin-'))
process.env.YOINKS_BIN_DIR = binDir
process.env.PATH = '' // no system yt-dlp unless a test says there is one

const asset =
  process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
const body = Buffer.from('not really yt-dlp')
const good = createHash('sha256').update(body).digest('hex')

// stands in for yt-dlp's signing key
const signer = generateKeyPairSync('rsa', {modulusLength: 2048})
const fingerprint = '12'.repeat(20)
TRUSTED_KEYS.push({fingerprint, key: signer.publicKey})

let sums = ''
let sigMode: 'good' | 'missing' | 'forged' = 'good'
let releaseDown = false
const fetched: string[] = []
globalThis.fetch = (async (url: string) => {
  const name = String(url).split('/').pop()!
  fetched.push(name)
  if (releaseDown || (name === 'SHA2-256SUMS.sig' && sigMode === 'missing')) return new Response('nope', {status: releaseDown ? 500 : 404})
  if (name === 'SHA2-256SUMS.sig') {
    const key = sigMode === 'forged' ? generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey : signer.privateKey
    return new Response(new Uint8Array(signDetached(Buffer.from(sums), key, fingerprint)))
  }
  return new Response(name === 'SHA2-256SUMS' ? sums : body)
}) as typeof fetch

// no real processes: only the freshly downloaded `*.download` file can "run", and only when `runnable`;
// a system yt-dlp exists only while `systemVersion` is set
let runnable = false
let systemVersion: string | undefined
cp.spawn = ((cmd: string) => {
  const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter()})
  setImmediate(() => {
    if (cmd.endsWith('.download')) child.emit('close', runnable ? 0 : 1)
    else if (cmd === 'yt-dlp' && systemVersion !== undefined) {
      child.stdout.emit('data', `${systemVersion}\n`)
      child.emit('close', 0)
    } else child.emit('error', new Error('ENOENT'))
  })
  return child
}) as unknown as typeof cp.spawn
syncBuiltinESMExports()
const {ensureYtDlp} = await import('./provision.js')

const setSystem = (platform: string, arch: string) => {
  Object.defineProperty(process, 'platform', {value: platform})
  Object.defineProperty(process, 'arch', {value: arch})
}

test.beforeEach(() => {
  sums = `${good}  ${asset}\n`
  sigMode = 'good'
  releaseDown = false
  runnable = true
  systemVersion = undefined
  fetched.length = 0
})

test('ensureYtDlp discards a binary whose hash does not match the release sums', async () => {
  sums = `${'0'.repeat(64)}  ${asset}\n`
  await assert.rejects(ensureYtDlp(() => {}), /failed its checksum check/)
  assert.deepEqual(fs.readdirSync(binDir), [])
})

test('ensureYtDlp rejects, before downloading, when the release sums do not list the asset', async () => {
  sums = `${good}  some-other-file\n`
  await assert.rejects(ensureYtDlp(() => {}), /does not list/)
  assert.deepEqual(fs.readdirSync(binDir), [])
  assert.ok(!fetched.includes(asset))
})

test('ensureYtDlp discards a verified binary that cannot run on this system', async () => {
  runnable = false
  await assert.rejects(ensureYtDlp(() => {}), /can’t run on this system/)
  assert.deepEqual(fs.readdirSync(binDir), []) // nothing installed, so the next launch won't mistake it for a copy
})

test('ensureYtDlp explains when the release has no standalone binary for this system', async () => {
  const {platform, arch} = process
  setSystem('linux', 'arm') // 32-bit ARM ships only a zip
  try {
    await assert.rejects(ensureYtDlp(() => {}), /no download for this system \(linux\/arm\)/)
  } finally {
    setSystem(platform, arch)
  }
  assert.deepEqual(fs.readdirSync(binDir), [])
})

test('ensureYtDlp installs nothing when the signature file is missing', async () => {
  sigMode = 'missing'
  await assert.rejects(ensureYtDlp(() => {}), /SHA2-256SUMS\.sig \(404\)/)
  assert.deepEqual(fs.readdirSync(binDir), [])
  assert.ok(!fetched.includes(asset))
})

test('ensureYtDlp installs nothing when the signature is from another key', async () => {
  sigMode = 'forged'
  await assert.rejects(ensureYtDlp(() => {}), /signature didn’t check out/)
  assert.deepEqual(fs.readdirSync(binDir), [])
  assert.ok(!fetched.includes(asset))
})

test('ensureYtDlp installs the binary when the signature and hash match', async () => {
  const resolved = await ensureYtDlp(() => {})
  assert.equal(path.dirname(resolved), binDir)
  assert.equal(fs.readFileSync(resolved, 'utf8'), 'not really yt-dlp')
  assert.equal(fs.readdirSync(binDir).length, 1)
})

test('a current system yt-dlp is used as is', async () => {
  systemVersion = new Date().toISOString().slice(0, 10).replaceAll('-', '.')
  assert.equal(await ensureYtDlp(() => {}), 'yt-dlp')
  assert.deepEqual(fetched, [])
})

test('an old system yt-dlp is replaced by a fresh managed copy', async () => {
  systemVersion = '2024.01.01'
  const resolved = await ensureYtDlp(() => {})
  assert.equal(path.dirname(resolved), binDir)
  assert.ok(fetched.includes(asset))
})

test('an old system yt-dlp is kept, with a note, when the fresh copy cannot be fetched', async () => {
  systemVersion = '2024.01.01'
  releaseDown = true
  const messages: string[] = []
  assert.equal(await ensureYtDlp(message => messages.push(message), undefined), 'yt-dlp')
  assert.match(messages.at(-1)!, /using your yt-dlp 2024\.01\.01 — it's old/)
  fs.rmSync(binDir, {recursive: true, force: true})
})
