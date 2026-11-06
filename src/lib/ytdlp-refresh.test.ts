import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// stand-in for yt-dlp: logs its argv; with --load-info-json (the cached info) it fails with $FAIL_WITH,
// otherwise it "downloads" and prints the final path
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-refresh-'))
const log = path.join(dir, 'argv.log')
const saved = path.join(dir, 'video.mp4')
const fake = path.join(dir, 'fake-ytdlp.cjs')
fs.writeFileSync(
  fake,
  `const fs = require('fs')\n` +
    `const args = process.argv.slice(2)\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')\n` +
    `if (args.includes('--load-info-json')) { console.error(process.env.FAIL_WITH); process.exit(1) }\n` +
    `console.log(${JSON.stringify(saved)})\n`,
)

const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args: string[], opts: never) =>
  cmd === 'taskkill' ? realSpawn(cmd, args, opts) : realSpawn(process.execPath, [fake, ...args], opts)) as typeof cp.spawn
syncBuiltinESMExports()
const {downloadWithRefresh} = await import('./ytdlp.js')

const run = async (failWith: string, handlers: {onRefresh?: () => void} = {}) => {
  fs.rmSync(log, {force: true})
  process.env.FAIL_WITH = failWith
  const result = await downloadWithRefresh(
    {ytdlp: 'unused', url: 'https://example.test/v', choice: {args: []} as never, outDir: dir, infoJsonPath: path.join(dir, 'info.json')},
    {onProgress() {}, onProcessing() {}, ...handlers},
  ).catch(error => error as Error)
  const calls: string[][] = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  return {result, calls}
}

test('an expired link (403) is retried once with a fresh extraction', async () => {
  let refreshed = 0
  const {result, calls} = await run('ERROR: unable to download video data: HTTP Error 403: Forbidden', {onRefresh: () => refreshed++})
  assert.equal(result, saved)
  assert.equal(refreshed, 1)
  assert.equal(calls.length, 2)
  assert.ok(calls[0]!.includes('--load-info-json'))
  assert.ok(!calls[1]!.includes('--load-info-json'))
  assert.ok(calls[1]!.includes('https://example.test/v')) // re-extracts from the link itself
})

test('any other failure is reported as it is, without a retry', async () => {
  let refreshed = 0
  const {result, calls} = await run('ERROR: unable to download video data: HTTP Error 404: Not Found', {onRefresh: () => refreshed++})
  assert.match((result as Error).message, /HTTP Error 404/)
  assert.equal(refreshed, 0)
  assert.equal(calls.length, 1)
  fs.rmSync(dir, {recursive: true, force: true})
})
