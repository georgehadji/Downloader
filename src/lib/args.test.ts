import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('parses scriptable flags and the output folder', () => {
  const url = 'https://example.com/v'
  assert.deepEqual(parseArgs(['--best', '-o', 'out', url]), {
    help: false,
    version: false,
    best: true,
    outDir: 'out',
    initialUrl: url,
  })
  assert.deepEqual(parseArgs([url, '--mp3', '--playlist', '--output=songs']), {
    help: false,
    version: false,
    mp3: true,
    playlist: true,
    outDir: 'songs',
    initialUrl: url,
  })
})

test('rejects flag combinations that cannot work', () => {
  const url = 'https://example.com/v'
  assert.match(parseArgs(['--best', '--mp3', url]).error ?? '', /not both/)
  assert.match(parseArgs(['--best']).error ?? '', /need a url/)
  assert.match(parseArgs(['--playlist', url]).error ?? '', /needs --best or --mp3/)
  assert.match(parseArgs(['-o']).error ?? '', /needs a folder/)
  assert.match(parseArgs(['--output=']).error ?? '', /needs a folder/)
})

test('rejects a command-line url that is not http(s)', () => {
  assert.match(parseArgs(['not-a-link']).error ?? '', /doesn’t look like a link/)
  assert.match(parseArgs(['file:///etc/passwd']).error ?? '', /doesn’t look like a link/)
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /needs a value/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /unknown theme/)
  assert.match(parseArgs(['--wat']).error ?? '', /unknown option/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto delegates to terminal colors while forced modes own the full surface', () => {
  assert.deepEqual(themeFor('auto'), {
    mode: 'auto',
    primary: undefined,
    gray: undefined,
    dark: undefined,
    background: undefined,
    dimSecondary: true,
    inverseButton: true,
  })

  assert.equal(themeFor('light').background, '#ffffff')
  assert.equal(themeFor('light').primary, '#18181b')
  assert.equal(themeFor('dark').background, '#18181b')
  assert.equal(themeFor('dark').primary, '#ffffff')
})
