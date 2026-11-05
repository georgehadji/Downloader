import {isThemeMode, type ThemeMode} from '../theme-mode.js'
import {isProbablyUrl} from './platforms.js'

export type CliArgs = {
  help: boolean
  version: boolean
  initialUrl?: string
  themeMode?: ThemeMode
  /** Scriptable mode: skip the picker and download the best video (--best) or an mp3 (--mp3). */
  best?: true
  mp3?: true
  /** Download every video of a playlist (scriptable mode only). */
  playlist?: true
  outDir?: string
  error?: string
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {help: false, version: false}
  const positional: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') {
      result.help = true
    } else if (arg === '-v' || arg === '--version') {
      result.version = true
    } else if (arg === '--best') {
      result.best = true
    } else if (arg === '--mp3') {
      result.mp3 = true
    } else if (arg === '--playlist') {
      result.playlist = true
    } else if (arg === '-o' || arg === '--output') {
      const value = args[++index]
      if (!value) return {...result, error: `${arg} needs a folder`}
      result.outDir = value
    } else if (arg.startsWith('--output=')) {
      const value = arg.slice('--output='.length)
      if (!value) return {...result, error: '--output needs a folder'}
      result.outDir = value
    } else if (arg === '--theme') {
      const value = args[++index]
      if (!value) return {...result, error: '--theme needs a value: auto, light, or dark'}
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('--theme=')) {
      const value = arg.slice('--theme='.length)
      if (!isThemeMode(value)) return {...result, error: `unknown theme “${value}” — use auto, light, or dark`}
      result.themeMode = value
    } else if (arg.startsWith('-')) {
      return {...result, error: `unknown option “${arg}”`}
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) return {...result, error: 'expected a single url'}
  result.initialUrl = positional[0]

  // a typed link is checked in the app; one from the command line is checked here
  if (result.initialUrl && !isProbablyUrl(result.initialUrl)) {
    return {...result, error: `“${result.initialUrl}” doesn’t look like a link — use a full http(s) url`}
  }
  if (result.best && result.mp3) return {...result, error: 'use either --best or --mp3, not both'}
  const scripted = result.best || result.mp3
  if (scripted && !result.initialUrl) return {...result, error: '--best and --mp3 need a url'}
  if (result.playlist && !scripted) return {...result, error: '--playlist needs --best or --mp3'}
  return result
}
