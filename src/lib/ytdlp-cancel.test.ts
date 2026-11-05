import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// stand-in for yt-dlp. CANCEL_MODE=playlist: video 1 is finished and printed, video 2 is
// mid-download. CANCEL_MODE=single: one video, mid-download, nothing finished yet.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-cancel-'))
const done = path.join(dir, 'one.mp4')
const partial = path.join(dir, 'two.mp4')
const fake = path.join(dir, 'fake-ytdlp.cjs')
fs.writeFileSync(
  fake,
  `const fs = require('fs')\n` +
    `if (process.env.CANCEL_MODE === 'playlist') {\n` +
    `  fs.writeFileSync(${JSON.stringify(done)}, 'finished video')\n` +
    `  console.log('[download] Destination: ' + ${JSON.stringify(done)})\n` +
    `  console.log(${JSON.stringify(done)})\n` +
    `}\n` +
    `console.log('[download] Destination: ' + ${JSON.stringify(partial)})\n` +
    `fs.writeFileSync(${JSON.stringify(partial + '.part')}, 'half a video')\n` +
    `setInterval(() => {}, 1000)\n`,
)

const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args: string[], opts: never) =>
  cmd === 'taskkill' ? realSpawn(cmd, args, opts) : realSpawn(process.execPath, [fake], opts)) as typeof cp.spawn
syncBuiltinESMExports()
const {download} = await import('./ytdlp.js')

async function cancelMidDownload(mode: 'playlist' | 'single') {
  process.env.CANCEL_MODE = mode
  for (const file of [done, partial, partial + '.part']) fs.rmSync(file, {force: true})
  const controller = new AbortController()
  const run = download(
    {ytdlp: 'unused', url: 'https://example.test/v', choice: {args: []} as never, outDir: dir, playlist: mode === 'playlist'},
    {onProgress() {}, onProcessing() {}},
    controller.signal,
  )
  const settled = assert.rejects(run, /Download cancelled/)
  while (!fs.existsSync(partial + '.part')) await new Promise(r => setTimeout(r, 25))
  await new Promise(r => setTimeout(r, 200)) // let the parent read the child's last stdout lines first
  controller.abort()
  await settled
  // cleanup runs once the process is really gone (taskkill takes a moment) and is fire-and-forget
  for (let waited = 0; fs.existsSync(partial + '.part') && waited < 3000; waited += 50) {
    await new Promise(r => setTimeout(r, 50))
  }
}

test('cancelling a playlist run removes the unfinished video but keeps the finished ones', async () => {
  await cancelMidDownload('playlist')
  assert.equal(fs.existsSync(done), true, 'the finished video must survive a cancel')
  assert.equal(fs.existsSync(partial + '.part'), false, 'the half-written video should be cleaned up')
})

test('cancelling a single-video run still removes everything it wrote', async () => {
  await cancelMidDownload('single')
  assert.equal(fs.existsSync(partial + '.part'), false)
  assert.equal(fs.existsSync(done), false)
  fs.rmSync(dir, {recursive: true, force: true})
})
