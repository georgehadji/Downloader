import assert from 'node:assert/strict'
import cp, {type ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The standalone yt-dlp.exe is a launcher that runs the real yt-dlp as its child.
// Killing only the launcher leaves that child holding yt-dlp's pipes, so 'close'
// never fires and download() never settles (seen with the real binary against a
// server that went silent). The fix is to kill the whole tree with taskkill /T,
// so the contract tested here is: a stalled run asks taskkill for the child's tree.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-tree-'))
const fake = path.join(dir, 'fake-ytdlp.cjs')
fs.writeFileSync(
  fake,
  `console.log('[download] Destination: ' + require('path').join(${JSON.stringify(dir)}, 'x.mp4'))\n` +
    `setInterval(() => {}, 1000)\n`,
)

const taskkills: string[][] = []
let fakePid: number | undefined
const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args: string[], opts: never) => {
  if (cmd === 'taskkill') {
    taskkills.push(args)
    return realSpawn(cmd, args, opts) // really kill the stand-in so 'close' fires
  }
  const child: ChildProcess = realSpawn(process.execPath, [fake], opts)
  fakePid = child.pid
  return child
}) as typeof cp.spawn
syncBuiltinESMExports()
const {download} = await import('./ytdlp.js')

test(
  'a stalled download kills yt-dlp\'s whole process tree, not just the launcher',
  {skip: process.platform !== 'win32' && 'Windows-only: elsewhere the bundle forwards the signal'},
  async () => {
    await assert.rejects(
      download(
        {ytdlp: 'unused', url: 'https://example.test/v', choice: {args: []} as never, outDir: dir, silenceLimitMs: 300},
        {onProgress() {}, onProcessing() {}},
      ),
      /Download stalled/,
    )
    assert.deepEqual(taskkills, [['/pid', String(fakePid), '/T', '/F']])
    fs.rmSync(dir, {recursive: true, force: true})
  },
)
