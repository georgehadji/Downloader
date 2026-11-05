import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {debug} from './debug.js'

test('debug writes only when YOINKS_DEBUG is set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-debug-'))
  const file = path.join(dir, 'sub', 'debug.log')
  process.env.YOINKS_DEBUG_FILE = file

  delete process.env.YOINKS_DEBUG
  debug('silent')
  assert.equal(fs.existsSync(file), false)

  process.env.YOINKS_DEBUG = '1'
  debug('first')
  debug('second')
  assert.match(fs.readFileSync(file, 'utf8'), /first\n.*second\n$/s)
  fs.rmSync(dir, {recursive: true, force: true})
})
