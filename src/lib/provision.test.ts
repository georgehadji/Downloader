import assert from 'node:assert/strict'
import test from 'node:test'
import {checksumFor, isOutdated} from './provision.js'

test('checksumFor picks the exact asset line and rejects anything else', () => {
  const sums = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp_linux_aarch64\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB *yt-dlp_linux\n`
  assert.equal(checksumFor(sums, 'yt-dlp_linux'), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(checksumFor(sums, 'yt-dlp_linux_aarch64'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(checksumFor(sums, 'yt-dlp.exe'), undefined)
  assert.equal(checksumFor('nothex  yt-dlp.exe', 'yt-dlp.exe'), undefined)
})

test('isOutdated compares the release date, and never overrides a version it cannot read', () => {
  const now = Date.UTC(2026, 10, 6)
  assert.equal(isOutdated('2026.10.26', now), false)
  assert.equal(isOutdated('2026.10.26.123456', now), false) // nightly
  assert.equal(isOutdated('2025.01.01\n', now), true)
  assert.equal(isOutdated('2026.08.08', now), false) // exactly 90 days
  assert.equal(isOutdated('2026.08.07', now), true)
  assert.equal(isOutdated('abc', now), false)
  assert.equal(isOutdated('', now), false)
})
