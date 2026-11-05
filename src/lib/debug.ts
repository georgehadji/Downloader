import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Opt-in diagnostics: `YOINKS_DEBUG=1 yoinks …` appends yt-dlp's command line,
 * exit code and full stderr to ~/.yoinks/debug.log (or $YOINKS_DEBUG_FILE).
 * A file, not stderr: the TUI owns the terminal.
 */
export function debug(message: string): void {
  if (!process.env.YOINKS_DEBUG) return
  const file = process.env.YOINKS_DEBUG_FILE ?? path.join(os.homedir(), '.yoinks', 'debug.log')
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // diagnostics must never break a download
  }
}
