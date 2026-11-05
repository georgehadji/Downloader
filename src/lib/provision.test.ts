import assert from 'node:assert/strict'
import test from 'node:test'
import {checksumFor} from './provision.js'

test('checksumFor picks the exact asset line and rejects anything else', () => {
  const sums = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp_linux_aarch64\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *yt-dlp_linux\n`
  assert.equal(checksumFor(sums, 'yt-dlp_linux'), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(checksumFor(sums, 'yt-dlp_linux_aarch64'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(checksumFor(sums, 'yt-dlp.exe'), undefined)
  assert.equal(checksumFor('nothex  yt-dlp.exe', 'yt-dlp.exe'), undefined)
})
