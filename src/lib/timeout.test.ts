import assert from 'node:assert/strict'
import test, {mock} from 'node:test'
import {withTimeout} from './timeout.js'

test('withTimeout aborts after the limit and reports it as a timeout', () => {
  mock.timers.enable({apis: ['setTimeout']})
  try {
    const limit = withTimeout(1000)
    mock.timers.tick(999)
    assert.equal(limit.signal.aborted, false)
    mock.timers.tick(1)
    assert.equal(limit.signal.aborted, true)
    assert.equal(limit.timedOut, true)
  } finally {
    mock.timers.reset()
  }
})

test('withTimeout follows the parent abort without calling it a timeout, and clear() stops the timer', () => {
  const parent = new AbortController()
  const limit = withTimeout(60_000, parent.signal)
  parent.abort()
  assert.equal(limit.signal.aborted, true)
  assert.equal(limit.timedOut, false)
  limit.clear()
  const alreadyAborted = withTimeout(60_000, AbortSignal.abort())
  assert.equal(alreadyAborted.signal.aborted, true)
  alreadyAborted.clear() // else its 60 s timer keeps the test process alive
})
