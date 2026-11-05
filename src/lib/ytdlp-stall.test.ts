import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// stand-in for yt-dlp: announces a download, then goes silent forever
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-stall-'))
const fake = path.join(dir, 'fake-ytdlp.cjs')
const pidFile = path.join(dir, 'pid.txt')
// STALL_MODE=ffmpeg: goes quiet inside the processing phase, then finishes normally
fs.writeFileSync(
  fake,
  `const p = require('path')\n` +
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
    `if (process.env.STALL_MODE === 'ffmpeg') {\n` +
    `  console.log('[Merger] Merging formats into "x.mp4"')\n` +
    `  setTimeout(() => { console.log(p.join(${JSON.stringify(dir)}, 'x.mp4')); process.exit(0) }, 1200)\n` +
    `} else {\n` +
    `  console.log('[download] Destination: ' + p.join(${JSON.stringify(dir)}, 'x.mp4'))\n` +
    `  setInterval(() => {}, 1000)\n` +
    `}\n`,
)

// download() spawns through the module binding, so swap it before importing
const realSpawn = cp.spawn
cp.spawn = ((_cmd: string, _args: string[], opts: never) => realSpawn(process.execPath, [fake], opts)) as typeof cp.spawn
syncBuiltinESMExports()
const {download} = await import('./ytdlp.js')

test('download kills a silent child and reports a stall, keeping the run resumable', async () => {
  await assert.rejects(
    download(
      {ytdlp: 'unused', url: 'https://example.test/v', choice: {args: []} as never, outDir: dir, silenceLimitMs: 300},
      {onProgress() {}, onProcessing() {}},
    ),
    /Download stalled — no data for 0\.3 s/,
  )
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), 'child should be dead')
})

test('download never calls silence during post-processing, however long ffmpeg is quiet', async () => {
  process.env.STALL_MODE = 'ffmpeg'
  // 4x the limit of silence while processing — a downloading-phase child would be killed
  const file = await download(
    {ytdlp: 'unused', url: 'https://example.test/v', choice: {args: []} as never, outDir: dir, silenceLimitMs: 300},
    {onProgress() {}, onProcessing() {}},
  )
  assert.equal(file, path.join(dir, 'x.mp4'))
  delete process.env.STALL_MODE
  fs.rmSync(dir, {recursive: true, force: true})
})
