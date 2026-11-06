import {useCallback, useEffect, useRef, useState} from 'react'
import {addToHistory, loadHistory} from './history.js'
import {detectPlatform, isProbablyUrl, type Platform} from './platforms.js'
import {ensureYtDlp, findFfmpeg} from './provision.js'
import {discardInfoJson} from './info-files.js'
import {
  buildChoices,
  downloadWithRefresh,
  probe,
  type DownloadChoice,
  type DownloadProgress,
  type VideoInfo,
} from './ytdlp.js'

export type Outcome = {filepath?: string}

export type Phase =
  | {name: 'input'; warning?: string}
  | {name: 'probing'; status: string}
  | {name: 'picking'}
  | {
      name: 'downloading'
      choice: DownloadChoice
      progress?: DownloadProgress
      processing: boolean
      refreshing?: boolean
    }
  | {name: 'done'; filepath: string}
  | {name: 'error'; message: string}

const PLAYLIST_MESSAGE =
  'That link is a whole playlist — run “yoinks --best --playlist <url>” (or --mp3) to get every video.'

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The download workflow as a state machine: input → probing → picking →
 * downloading → done/error. The component only renders `phase` and calls the
 * actions, so none of this needs a terminal to reason about.
 */
export function useYoinkFlow({
  initialUrl,
  outDir,
  onOutcome,
}: {
  initialUrl?: string
  outDir: string
  onOutcome: (outcome: Outcome) => void
}) {
  const [url, setUrl] = useState(initialUrl ?? '')
  const [urlInput, setUrlInput] = useState('')
  const [history, setHistory] = useState(loadHistory)
  const [platform, setPlatform] = useState<Platform>()
  const [info, setInfo] = useState<VideoInfo>()
  const [choices, setChoices] = useState<DownloadChoice[]>([])
  const ytdlpRef = useRef('')
  const infoJsonRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(initialUrl ? {name: 'probing', status: 'warming up…'} : {name: 'input'})

  const startProbe = useCallback(async (targetUrl: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    setPlatform(detectPlatform(targetUrl))
    setPhase({name: 'probing', status: 'warming up…'})
    try {
      const ytdlp =
        ytdlpRef.current ||
        (await ensureYtDlp(status => setPhase({name: 'probing', status}), controller.signal))
      ytdlpRef.current = ytdlp
      if (controller.signal.aborted) return
      setPhase({name: 'probing', status: 'fetching video info…'})
      const {info: videoInfo, infoJsonPath} = await probe(ytdlp, targetUrl, controller.signal)
      if (controller.signal.aborted) {
        void discardInfoJson(infoJsonPath)
        return
      }
      if (videoInfo._type === 'playlist') {
        void discardInfoJson(infoJsonPath)
        setPhase({name: 'error', message: PLAYLIST_MESSAGE})
        return
      }
      infoJsonRef.current = infoJsonPath
      setInfo(videoInfo)
      setChoices(buildChoices(videoInfo))
      setPhase({name: 'picking'})
    } catch (error) {
      if (controller.signal.aborted) return
      setPhase({name: 'error', message: errorMessage(error)})
    }
  }, [])

  useEffect(() => {
    if (initialUrl) void startProbe(initialUrl)
  }, [initialUrl, startProbe])

  // quitting mid-run cancels it, so yt-dlp stops and its partials are removed instead of finishing after the UI is gone
  useEffect(() => () => abortRef.current?.abort(), [])

  // every way back to the input screen passes through here, so this is the
  // one place the probe's info file gets released
  const resetToInput = useCallback(() => {
    if (infoJsonRef.current) void discardInfoJson(infoJsonRef.current)
    infoJsonRef.current = undefined
    setUrl('')
    setUrlInput('')
    setPlatform(undefined)
    setInfo(undefined)
    setChoices([])
    setPhase({name: 'input'})
  }, [])

  const cancelRun = useCallback(() => {
    abortRef.current?.abort()
    resetToInput()
    setUrlInput(url) // keep the link around so a cancel isn't destructive
  }, [resetToInput, url])

  // esc/logo/hint all mean "back": cancel the running work, or just clear the screen
  const goBack = phase.name === 'probing' || phase.name === 'downloading' ? cancelRun : resetToInput

  const submitUrl = (value: string) => {
    const trimmed = value.trim()
    if (!isProbablyUrl(trimmed)) {
      setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
      return
    }
    setUrl(trimmed)
    void startProbe(trimmed)
  }

  const pick = (index: number) => {
    const choice = choices[index]
    if (!choice) return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({name: 'downloading', choice, processing: false})
    void (async () => {
      const handlers = {
        onProgress: (progress: DownloadProgress) =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, progress, processing: false} : prev)),
        onProcessing: () =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, processing: true} : prev)),
      }
      try {
        const ffmpegLocation = await findFfmpeg()
        // reuse the probe's metadata — starts immediately instead of re-extracting
        const filepath = await downloadWithRefresh(
          {ytdlp: ytdlpRef.current, ffmpegLocation, url, choice, outDir, infoJsonPath: infoJsonRef.current},
          {
            ...handlers,
            // media urls in the cached info can expire — the retry re-extracts
            onRefresh: () =>
              setPhase(prev => (prev.name === 'downloading' ? {...prev, progress: undefined, refreshing: true} : prev)),
          },
          controller.signal,
        )
        onOutcome({filepath})
        setHistory(addToHistory(url))
        setPhase({name: 'done', filepath})
      } catch (error) {
        if (controller.signal.aborted) return
        setPhase({name: 'error', message: errorMessage(error)})
      }
    })()
  }

  return {phase, url, urlInput, setUrlInput, history, platform, info, choices, submitUrl, pick, goBack, resetToInput}
}
