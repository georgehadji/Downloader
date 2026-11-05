import React from 'react'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {render} from 'ink'
import {App, type Outcome} from './app.js'
import {captureFrames} from './lib/click-map.js'
import {parseArgs} from './lib/args.js'
import {formatProgress, yoinkHeadless} from './lib/headless.js'
import {ensureYtDlp, findFfmpeg} from './lib/provision.js'

// read at runtime from the shipped package.json so npm version bumps
// can't drift from a hardcoded constant
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const HELP = `
  yoinks — yoink any video. paste. yoink. done.

  Usage
    $ yoinks [url]
    $ yoinks --best|--mp3 <url>     (no picker — prints the saved file path)

  Examples
    $ yoinks https://youtu.be/dQw4w9WgXcQ
    $ yoinks https://x.com/user/status/123456
    $ yoinks                 (prompts for a url)
    $ yoinks --mp3 -o ~/Music https://youtu.be/dQw4w9WgXcQ
    $ yoinks --best --playlist https://www.youtube.com/playlist?list=…

  Options
    --best          download the best quality as mp4, then exit
    --mp3           download audio only as mp3, then exit
    --playlist      with --best/--mp3: every video of a playlist link
    -o, --output <folder>  where to save (default ~/Downloads)
    --theme <mode>  use auto, light, or dark for this run
    -h, --help      show this help
    -v, --version   show version

  Powered by yt-dlp — YouTube, X, Instagram, Threads, TikTok & 1800+ sites.
  Set YOINKS_DEBUG=1 to log yt-dlp's output to ~/.yoinks/debug.log.
`

const args = parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`yoinks: ${args.error}\nTry “yoinks --help” for usage.`)
  process.exit(1)
}

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

if (args.version) {
  console.log(VERSION)
  process.exit(0)
}

const outDir = path.resolve(args.outDir ?? path.join(os.homedir(), 'Downloads'))

if (args.best || args.mp3) {
  // scriptable mode: stdout carries only the saved paths, everything else goes to stderr
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  const showProgress = Boolean(process.stderr.isTTY)
  try {
    const ytdlp = await ensureYtDlp(message => console.error(message), controller.signal)
    const report = await yoinkHeadless(
      {
        ytdlp,
        ffmpegLocation: await findFfmpeg(),
        url: args.initialUrl!,
        audio: Boolean(args.mp3),
        playlist: Boolean(args.playlist),
        outDir,
      },
      progress => showProgress && process.stderr.write(`\r\x1b[K${formatProgress(progress)}`),
      controller.signal,
    )
    if (showProgress) process.stderr.write('\r\x1b[K')
    for (const file of report.files) console.log(file)
    if (report.warning) {
      console.error(`yoinks: ${report.warning}`)
      process.exit(1)
    }
    process.exit(0)
  } catch (error) {
    if (showProgress) process.stderr.write('\r\x1b[K')
    console.error(`yoinks: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

const initialUrl = args.initialUrl
const initialThemeMode = args.themeMode ?? 'auto'

const isTTY = Boolean(process.stdout.isTTY)

const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H')
// also switch mouse tracking off — a crash can skip React effect cleanup
const leaveAltScreen = () => process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')

if (isTTY) {
  enterAltScreen()
  process.on('exit', leaveAltScreen)
  // restore the terminal BEFORE a crash prints, or the stack trace is
  // wiped along with the alternate screen and the app looks like it
  // silently quit
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      leaveAltScreen()
      console.error(error)
      process.exit(1)
    })
  }
}

let outcome: Outcome = {}
const {waitUntilExit} = render(
  <App
    initialUrl={initialUrl}
    initialThemeMode={initialThemeMode}
    outDir={outDir}
    onOutcome={result => (outcome = result)}
  />,
  // keep a copy of every frame so clicks can be hit-tested against it
  {stdout: captureFrames(process.stdout)},
)

await waitUntilExit()

if (isTTY) leaveAltScreen()
if (outcome.filepath) {
  console.log(`✓ yoinked → ${outcome.filepath}`)
}
