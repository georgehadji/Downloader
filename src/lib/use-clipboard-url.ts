import {useEffect, useState} from 'react'
import {readClipboard} from './clipboard.js'
import {isProbablyUrl} from './platforms.js'

/**
 * The url on the clipboard, once it has been read. The read runs after the
 * first frame so a slow clipboard tool can't hold up startup.
 */
export function useClipboardUrl(enabled: boolean): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void readClipboard(controller.signal).then(text => {
      const clipped = text.trim()
      // reject multi-line clipboard content — new URL() silently strips newlines
      if (!controller.signal.aborted && clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) setUrl(clipped)
    })
    return () => controller.abort()
  }, [enabled])

  return url
}
