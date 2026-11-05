import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {discardInfoJson, saveInfoJson, sweepStaleInfoFiles} from './info-files.js'

test('saveInfoJson writes the json and discardInfoJson removes it', async () => {
  const file = await saveInfoJson('{"title":"x"}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"title":"x"}')
  await discardInfoJson(file)
  assert.equal(fs.existsSync(file), false)
})

test('sweepStaleInfoFiles removes only old yoinks info files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-sweep-'))
  const old = path.join(dir, 'yoinks-info-1-2.json')
  const fresh = path.join(dir, 'yoinks-info-3-4.json')
  const other = path.join(dir, 'notes.json')
  for (const file of [old, fresh, other]) fs.writeFileSync(file, '{}')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo)
  fs.utimesSync(other, twoDaysAgo, twoDaysAgo)

  await sweepStaleInfoFiles(dir)

  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.json', 'yoinks-info-3-4.json'])
  fs.rmSync(dir, {recursive: true, force: true})
})
