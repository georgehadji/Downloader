import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// stand-in for yt-dlp: prints two finished files, then exits with FAKE_EXIT
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-headless-'))
const fake = path.join(dir, 'fake-ytdlp.cjs')
fs.writeFileSync(
  fake,
  `const p = require('path'), d = ${JSON.stringify(dir)}\n` +
    `console.log(p.join(d, 'a.mp4'))\nconsole.log(p.join(d, 'b.mp4'))\n` +
    `process.exit(Number(process.env.FAKE_EXIT || 0))\n`,
)

const calls: string[][] = []
const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args: string[], opts: never) => {
  if (cmd === 'taskkill') return realSpawn(cmd, args, opts)
  calls.push(args)
  return realSpawn(process.execPath, [fake], opts)
}) as typeof cp.spawn
syncBuiltinESMExports()
const {yoinkHeadless, formatProgress} = await import('./headless.js')

const base = {ytdlp: 'unused', url: 'https://example.test/v', outDir: dir}

test('a single best-video run asks yt-dlp for one video and reports every file it printed', async () => {
  process.env.FAKE_EXIT = '0'
  const report = await yoinkHeadless({...base, audio: false, playlist: false})
  assert.deepEqual(report.files, [path.join(dir, 'a.mp4'), path.join(dir, 'b.mp4')])
  assert.equal(report.warning, undefined)
  const args = calls.at(-1)!
  assert.ok(args.includes('--no-playlist') && !args.includes('--yes-playlist'))
  assert.ok(args.includes('bv*+ba/b') && args.includes('mp4'))
})

test('a playlist mp3 run extracts audio, and keeps the files when some videos fail', async () => {
  process.env.FAKE_EXIT = '1'
  const report = await yoinkHeadless({...base, audio: true, playlist: true})
  assert.equal(report.files.length, 2)
  assert.match(report.warning ?? '', /some videos failed/)
  const args = calls.at(-1)!
  assert.ok(args.includes('--yes-playlist') && !args.includes('--no-playlist'))
  assert.ok(args.includes('-x') && args.includes('mp3'))
})

test('a single-video run that exits non-zero still fails', async () => {
  process.env.FAKE_EXIT = '1'
  await assert.rejects(yoinkHeadless({...base, audio: false, playlist: false}), /yt-dlp exit code 1/)
  fs.rmSync(dir, {recursive: true, force: true})
})

test('formatProgress shows percent and speed, and degrades without a total', () => {
  const p = {downloadedBytes: 50, totalBytes: 200, speed: 1024 * 1024, part: 0, totalParts: 1}
  assert.match(formatProgress(p), /^25%  /)
  assert.equal(formatProgress({downloadedBytes: 5, part: 0, totalParts: 1}), '')
})
