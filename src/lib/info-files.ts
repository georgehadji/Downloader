import {rmSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const NAME = /^yoinks-info-\d+-\d+\.json$/

// info files this run wrote; the exit handler is the backstop for paths that
// never reach discardInfoJson (ctrl-c, crash)
const infoFiles = new Set<string>()
process.on('exit', () => {
  for (const file of infoFiles) {
    try {
      rmSync(file, {force: true})
    } catch {
      // EBUSY on Windows must not turn into an exit-time crash
    }
  }
})

/** Write the raw `-J` output where a later download can load it with --load-info-json. */
export async function saveInfoJson(json: string): Promise<string> {
  const file = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  infoFiles.add(file)
  // 0600: the info holds signed media urls, no reason for other users to read it
  await fs.writeFile(file, json, {mode: 0o600})
  return file
}

export function discardInfoJson(file: string): Promise<void> {
  return fs.rm(file, {force: true}).then(
    () => void infoFiles.delete(file),
    () => {},
  )
}

/**
 * A SIGKILL skips the exit handler and leaks the file; remove ones old enough
 * that no live run can still need them.
 */
export async function sweepStaleInfoFiles(dir = os.tmpdir(), maxAgeMs = DAY_MS): Promise<void> {
  try {
    for (const name of await fs.readdir(dir)) {
      if (!NAME.test(name)) continue
      const file = path.join(dir, name)
      if (infoFiles.has(file)) continue
      const {mtimeMs} = await fs.stat(file).catch(() => ({mtimeMs: Date.now()}))
      if (Date.now() - mtimeMs > maxAgeMs) await fs.rm(file, {force: true})
    }
  } catch {
    // housekeeping only — never worth failing a probe over
  }
}
