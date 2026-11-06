import assert from 'node:assert/strict'
import test from 'node:test'
import {shortenPath, stripControlChars} from './format.js'

test('shortenPath replaces the home folder with ~', () => {
  assert.equal(shortenPath('/home/al/x.mp4', '/home/al'), '~/x.mp4')
  assert.equal(shortenPath('/home/al', '/home/al'), '~')
  assert.equal(shortenPath('C:\\Users\\tesse\\D\\x.mp4', 'C:\\Users\\tesse'), '~\\D\\x.mp4')
})

test('shortenPath leaves look-alike folders alone', () => {
  assert.equal(shortenPath('/home/alice/x.mp4', '/home/al'), '/home/alice/x.mp4')
  assert.equal(shortenPath('C:\\Users\\tesse2\\x.mp4', 'C:\\Users\\tesse'), 'C:\\Users\\tesse2\\x.mp4')
})

test('stripControlChars removes escape sequences and C1 controls but keeps text', () => {
  assert.equal(stripControlChars('a\x1b]52;c;ZXZpbA==\x07b\x9bc\x7fd'), 'a]52;c;ZXZpbA==bcd')
  assert.equal(stripControlChars('plain ✓ text'), 'plain ✓ text')
})
