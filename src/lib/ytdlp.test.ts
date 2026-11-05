import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildChoices,
  isExpiredLinkError,
  newParseState,
  parseDownloadLine,
  type VideoInfo,
} from './ytdlp.js'

const MB = 1024 * 1024

const info: VideoInfo = {
  title: 'fixture',
  formats: [
    {format_id: 'v1', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 4000, filesize: 20 * MB},
    {format_id: 'v2', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, tbr: 3000, filesize: 30 * MB},
    {format_id: 'm1', ext: 'mp4', vcodec: 'avc1.42001e', acodec: 'mp4a.40.2', height: 360, tbr: 500, filesize: 5 * MB},
    {format_id: 'a1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 2 * MB},
  ],
}

test('lists one choice per height, tallest first, then audio', () => {
  assert.deepEqual(
    buildChoices(info).map(c => c.label),
    ['1080p · mp4 · ~22 MB', '360p · mp4 · ~5.0 MB', 'audio only · mp3 · ~2.0 MB'],
  )
})

test('video choices select by height and merge to mp4; audio extracts mp3', () => {
  const [top, , audio] = buildChoices(info)
  assert.equal(top.kind, 'video')
  assert.ok(top.args.includes('bv*[height=1080]+ba/b[height=1080]/bv*[height<=1080]+ba/b'))
  assert.deepEqual(top.args.slice(-2), ['--merge-output-format', 'mp4'])
  assert.equal(audio.kind, 'audio')
  assert.ok(audio.args.includes('-x'))
})

test('falls back to best available when no format reports a height', () => {
  assert.deepEqual(
    buildChoices({title: 'x', formats: []}).map(c => c.label),
    ['best available · mp4', 'audio only · mp3'],
  )
})

test('caps the video list at 8 heights', () => {
  const formats = [144, 240, 360, 480, 540, 720, 900, 1080, 1440, 2160].map(height => ({
    format_id: String(height),
    ext: 'mp4',
    vcodec: 'avc1',
    acodec: 'none',
    height,
  }))
  const video = buildChoices({title: 'x', formats}).filter(c => c.kind === 'video')
  assert.equal(video.length, 8)
  assert.match(video[0].label, /^2160p/)
})

test('only 403 and 410 count as an expired link', () => {
  assert.equal(isExpiredLinkError(new Error('unable to download: HTTP Error 403: Forbidden')), true)
  assert.equal(isExpiredLinkError(new Error('HTTP Error 410: Gone')), true)
  assert.equal(isExpiredLinkError(new Error('HTTP Error 404: Not Found')), false)
  assert.equal(isExpiredLinkError(new Error('HTTP Error 4030')), false)
  assert.equal(isExpiredLinkError('HTTP Error 403'), false)
})

test('parseDownloadLine: progress lines, with NA fields and the next file resetting the counter', () => {
  const state = newParseState()
  assert.equal(parseDownloadLine(state, '[info] abc: Downloading 1 format(s): 137+140'), undefined)
  assert.equal(state.totalParts, 2)

  const first = parseDownloadLine(state, 'YOINK|500|1000|NA|250.5|4')
  assert.deepEqual(first, {
    kind: 'progress',
    progress: {downloadedBytes: 500, totalBytes: 1000, speed: 250.5, eta: 4, part: 0, totalParts: 2},
  })
  // audio file starts: byte counter drops, estimate used when total is NA
  const next = parseDownloadLine(state, 'YOINK|10|NA|900|NA|NA')
  assert.equal(next?.kind === 'progress' && next.progress.part, 1)
  assert.equal(next?.kind === 'progress' && next.progress.totalBytes, 900)
})

test('parseDownloadLine: destinations, processing and the final path', () => {
  const state = newParseState()
  const abs = path.join(os.tmpdir(), 'v [id] 240p.mp4')
  assert.equal(parseDownloadLine(state, '[download] Destination: /tmp/a.f137.mp4'), undefined)
  assert.deepEqual(parseDownloadLine(state, '[Merger] Merging formats into "/tmp/a.mp4"'), {kind: 'processing'})
  assert.deepEqual(parseDownloadLine(state, '[ExtractAudio] Destination: /tmp/a.mp3'), {kind: 'processing'})
  assert.deepEqual(state.destinations, ['/tmp/a.f137.mp4', '/tmp/a.mp4', '/tmp/a.mp3'])
  assert.equal(parseDownloadLine(state, ''), undefined)
  assert.deepEqual(parseDownloadLine(state, abs), {kind: 'file', filepath: abs})
  assert.deepEqual(state.filepaths, [abs])
  assert.equal(state.filepath, abs)
})

test('parseDownloadLine tracks the run phase so silence limits fit what yt-dlp is doing', () => {
  const state = newParseState()
  assert.equal(state.phase, 'preparing')
  parseDownloadLine(state, '[download] Destination: /tmp/a.f137.mp4')
  assert.equal(state.phase, 'downloading')
  parseDownloadLine(state, '[FixupM3u8] Fixing MPEG-TS in MP4 container')
  assert.equal(state.phase, 'processing')
  parseDownloadLine(state, 'YOINK|1|2|NA|NA|NA')
  assert.equal(state.phase, 'downloading')
  assert.deepEqual(parseDownloadLine(state, '[Merger] Merging formats into "/tmp/a.mp4"'), {kind: 'processing'})
  assert.equal(state.phase, 'processing')
})
