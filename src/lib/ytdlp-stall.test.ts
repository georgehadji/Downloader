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
fs.writeFileSync(
  fake,
  `console.log('[download] Destination: ' + require('path').join(${JSON.stringify(dir)}, 'x.mp4'))\n` +
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n` +
    `setInterval(() => {}, 1000)\n`,
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
  fs.rmSync(dir, {recursive: true, force: true})
})
