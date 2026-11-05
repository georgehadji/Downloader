import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const run = promisify(execFile)

const COMMANDS: Array<[string, string[]]> =
  process.platform === 'darwin'
    ? [['pbpaste', []]]
    : process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard']]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-selection', 'clipboard', '-o']],
          ['xsel', ['--clipboard', '--output']],
        ]

// async so a slow tool (cold PowerShell takes ~0.5s) never blocks the UI;
// the timeout is generous because the caller isn't waiting on it
export async function readClipboard(signal?: AbortSignal): Promise<string> {
  for (const [command, args] of COMMANDS) {
    try {
      const {stdout} = await run(command, args, {encoding: 'utf8', timeout: 2000, signal})
      return stdout
    } catch {
      if (signal?.aborted) return ''
      // tool missing or clipboard empty — try the next one
    }
  }
  return ''
}
