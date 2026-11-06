import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// stand-in for yt-dlp (and for the ffmpeg probe): $MODE picks what the download does
//   ok       prints one saved file, exits 0
//   fail     prints an ERROR line, exits 1
//   partial  one video lands, the next fails: prints its path and an ERROR line, exits 1
//   hang     starts a file and never finishes, so a test can cancel it
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-headless-'))
const saved = path.join(dir, 'video.mp4')
const half = path.join(dir, 'half.mp4')
const fake = path.join(dir, 'fake-ytdlp.cjs')
fs.writeFileSync(
  fake,
  `const fs = require('fs')\n` +
    `const args = process.argv.slice(2)\n` +
    `if (args.includes('--version') || args.includes('-version')) { console.log(new Date().toISOString().slice(0, 10).replaceAll('-', '.')); process.exit(0) }\n` +
    `const mode = process.env.MODE\n` +
    `if (mode === 'hang') {\n` +
    `  console.log('[download] Destination: ' + ${JSON.stringify(half)})\n` +
    `  fs.writeFileSync(${JSON.stringify(half + '.part')}, 'half a video')\n` +
    `  setInterval(() => {}, 1000)\n` +
    `} else {\n` +
    `  if (mode !== 'fail') { fs.writeFileSync(${JSON.stringify(saved)}, 'video'); console.log(${JSON.stringify(saved)}) }\n` +
    `  if (mode !== 'ok') { console.error('ERROR: [site] id: boom'); process.exit(1) }\n` +
    `}\n`,
)

const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args: string[], opts: never) =>
  cmd === 'taskkill' ? realSpawn(cmd, args, opts) : realSpawn(process.execPath, [fake, ...args], opts)) as typeof cp.spawn
syncBuiltinESMExports()
const {runHeadless} = await import('./headless.js')

async function run(mode: string, playlist = false, signal = new AbortController().signal) {
  process.env.MODE = mode
  fs.rmSync(saved, {force: true})
  const out: string[] = []
  let err = ''
  const code = await runHeadless(
    {url: 'https://example.test/v', audio: false, playlist, outDir: dir},
    {out: line => out.push(line), err: text => (err += text), isTTY: false},
    signal,
  )
  return {code, out, err}
}

test('a finished download exits 0 and prints exactly the saved path', async () => {
  const {code, out, err} = await run('ok')
  assert.equal(code, 0)
  assert.deepEqual(out, [saved])
  assert.equal(err, '')
})

test('a failed download exits 1 with a "yoinks:" message and prints no path', async () => {
  const {code, out, err} = await run('fail')
  assert.equal(code, 1)
  assert.deepEqual(out, [])
  assert.match(err, /^yoinks: id: boom\n$/)
})

test('a playlist where one video fails exits 1 but still prints the finished files', async () => {
  const {code, out, err} = await run('partial', true)
  assert.equal(code, 1)
  assert.deepEqual(out, [saved])
  assert.match(err, /^yoinks: id: boom\n$/)
})

test('cancelling exits 1 and leaves no partial file behind', async () => {
  const controller = new AbortController()
  const running = run('hang', false, controller.signal)
  while (!fs.existsSync(half + '.part')) await new Promise(r => setTimeout(r, 25))
  await new Promise(r => setTimeout(r, 200)) // let the parent read the child's Destination line first
  controller.abort()
  const {code, out, err} = await running
  assert.equal(code, 1)
  assert.deepEqual(out, [])
  assert.match(err, /^yoinks: Download cancelled\.\n$/)
  // cleanup is fire-and-forget once the process is really gone
  for (let waited = 0; fs.existsSync(half + '.part') && waited < 3000; waited += 50) await new Promise(r => setTimeout(r, 50))
  assert.equal(fs.existsSync(half + '.part'), false)
  fs.rmSync(dir, {recursive: true, force: true})
})
