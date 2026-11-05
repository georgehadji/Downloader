import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// each test file runs in its own process, so these globals are ours alone
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-bin-'))
process.env.YOINKS_BIN_DIR = binDir
process.env.PATH = '' // no system yt-dlp, so ensureYtDlp takes the fetch path

const asset =
  process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
const body = Buffer.from('not really yt-dlp')
const good = createHash('sha256').update(body).digest('hex')

let sums = ''
globalThis.fetch = (async (url: string) =>
  new Response(String(url).endsWith('SHA2-256SUMS') ? sums : body)) as typeof fetch

const {ensureYtDlp} = await import('./provision.js')

test('ensureYtDlp discards a binary whose hash does not match the release sums', async () => {
  sums = `${'0'.repeat(64)}  ${asset}\n`
  await assert.rejects(ensureYtDlp(() => {}), /failed its checksum check/)
  assert.deepEqual(fs.readdirSync(binDir), [])
})

test('ensureYtDlp rejects when the release sums do not list the asset', async () => {
  sums = `${good}  some-other-file\n`
  await assert.rejects(ensureYtDlp(() => {}), /failed its checksum check/)
  assert.deepEqual(fs.readdirSync(binDir), [])
})

test('ensureYtDlp installs the binary when the hash matches', async () => {
  sums = `${good}  ${asset}\n`
  const resolved = await ensureYtDlp(() => {})
  assert.equal(path.dirname(resolved), binDir)
  assert.equal(fs.readFileSync(resolved, 'utf8'), 'not really yt-dlp')
  assert.equal(fs.readdirSync(binDir).length, 1)
  fs.rmSync(binDir, {recursive: true, force: true})
})
