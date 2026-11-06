import assert from 'node:assert/strict'
import cp from 'node:child_process'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-update-'))
process.env.YOINKS_BIN_DIR = binDir
const local = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
fs.writeFileSync(local, 'stand-in')

// no real processes: the only "yt-dlp" that works is our stand-in at `local`
const calls: string[][] = []
let updateExitCode = 0
cp.spawn = ((cmd: string, args: string[]) => {
  calls.push([cmd === local ? 'local' : cmd, ...args])
  const child = new EventEmitter()
  setImmediate(() => {
    if (cmd !== local) child.emit('error', new Error('ENOENT'))
    else child.emit('close', args[0] === '-U' ? updateExitCode : 0)
  })
  return child
}) as unknown as typeof cp.spawn
syncBuiltinESMExports()
const {ensureYtDlp} = await import('./provision.js')

const ageDays = (days: number) => {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  fs.utimesSync(local, when, when)
}
const updates = () => calls.filter(c => c.includes('-U')).length

test('a copy older than 7 days is updated with -U and its age restarts', async () => {
  ageDays(10)
  assert.equal(await ensureYtDlp(() => {}), local)
  assert.equal(updates(), 1)
  assert.ok(Date.now() - fs.statSync(local).mtimeMs < 60_000)
})

test('a fresh copy is left alone', async () => {
  await ensureYtDlp(() => {})
  assert.equal(updates(), 1) // still just the one from before
})

test('a failed update retries in a day, not on every launch', async () => {
  ageDays(10)
  updateExitCode = 1
  assert.equal(await ensureYtDlp(() => {}), local) // a failed update must not break the run
  assert.equal(updates(), 2)
  const ageMs = Date.now() - fs.statSync(local).mtimeMs
  const day = 24 * 60 * 60 * 1000
  // about 6 days old (timestamp rounding makes the edge fuzzy): not stale yet, stale again in a day
  assert.ok(ageMs > 5.9 * day && ageMs < 7 * day, `age was ${ageMs / day} days`)
  await ensureYtDlp(() => {})
  assert.equal(updates(), 2) // the next launch skips the update
  fs.rmSync(binDir, {recursive: true, force: true})
})
