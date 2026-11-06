import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// stand-in for yt-dlp -J: prints $STDOUT, or fails with $STDERR when $EXIT is set
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-probe-'))
const fake = path.join(dir, 'fake-ytdlp.cjs')
fs.writeFileSync(
  fake,
  `if (process.env.EXIT) { console.error(process.env.STDERR); process.exit(Number(process.env.EXIT)) }\n` +
    `process.stdout.write(process.env.STDOUT)\n`,
)

const realSpawn = cp.spawn
cp.spawn = ((cmd: string, args: string[], opts: never) =>
  cmd === 'taskkill' ? realSpawn(cmd, args, opts) : realSpawn(process.execPath, [fake, ...args], opts)) as typeof cp.spawn
syncBuiltinESMExports()
const {probe} = await import('./ytdlp.js')
const {discardInfoJson} = await import('./info-files.js')

const stand = (env: {STDOUT?: string; STDERR?: string; EXIT?: string}) => {
  for (const key of ['STDOUT', 'STDERR', 'EXIT'] as const) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
}

test('probe returns the parsed info and saves the raw json for the download', async () => {
  const json = JSON.stringify({title: 'Ünïcode title', formats: []})
  stand({STDOUT: json})
  const {info, infoJsonPath} = await probe('unused', 'https://example.test/v')
  try {
    assert.equal(info.title, 'Ünïcode title')
    assert.equal(fs.readFileSync(infoJsonPath, 'utf8'), json)
  } finally {
    await discardInfoJson(infoJsonPath)
  }
  assert.equal(fs.existsSync(infoJsonPath), false)
})

test('probe reports yt-dlp’s own error line, cleaned', async () => {
  stand({EXIT: '1', STDERR: 'WARNING: noise\nERROR: [youtube] abc: Video unavailable \x1b]0;pwned\x07'})
  await assert.rejects(probe('unused', 'https://example.test/v'), /^Error: abc: Video unavailable \]0;pwned$/)
})

test('probe says so when yt-dlp prints something that is not json', async () => {
  stand({STDOUT: 'definitely not json'})
  await assert.rejects(probe('unused', 'https://example.test/v'), /Could not parse video info/)
  fs.rmSync(dir, {recursive: true, force: true})
})
