import React from 'react'
import {Box, Text} from 'ink'
import Spinner from 'ink-spinner'
import {formatBytes, formatDuration, formatSpeed, truncate} from '../lib/format.js'
import type {DownloadProgress} from '../lib/ytdlp.js'
import {useTheme} from '../theme.js'
import {Gap} from './gap.js'
import {ProgressBar} from './progress-bar.js'

// fixed-width slots — the centered line must not change width as values tick,
// otherwise the whole layout shifts on every progress update
function partLabel(progress: DownloadProgress): string {
  // explains the bar resetting between files (video, then audio)
  return progress.totalParts > 1 ? `part ${progress.part + 1}/${progress.totalParts}  ` : ''
}

function downloadMeta(progress: DownloadProgress): string {
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  const eta = progress.eta ? `${formatDuration(progress.eta)} left` : ''
  return `${partLabel(progress)}${speed.padStart(10)}  ${eta.padEnd(12)}`
}

function indeterminateMeta(progress: DownloadProgress): string {
  const bytes = formatBytes(progress.downloadedBytes)
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return `${partLabel(progress)}${bytes.padStart(8)}  ${speed.padEnd(10)}`
}

export function DownloadView({
  title,
  choiceLabel,
  progress,
  processing,
  refreshing,
}: {
  title?: string
  choiceLabel: string
  progress?: DownloadProgress
  processing: boolean
  refreshing?: boolean
}) {
  const theme = useTheme()
  const spinner = (text: string) => (
    <Text>
      <Text color={theme.primary}>
        <Spinner type="dots" />
      </Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>{text}</Text>
    </Text>
  )

  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={theme.gray} dimColor={theme.dimSecondary}>
        {title ? `${truncate(title, 42)} · ` : ''}
        {choiceLabel}
      </Text>
      <Gap />
      {/* every branch is exactly three rows — bar, gap, meta — so the layout never jumps */}
      {processing ? (
        <>
          <ProgressBar percent={1} />
          <Gap />
          {spinner(' processing…')}
        </>
      ) : progress?.totalBytes ? (
        <>
          <ProgressBar percent={progress.downloadedBytes / progress.totalBytes} />
          <Gap />
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{downloadMeta(progress)}</Text>
        </>
      ) : progress ? (
        <>
          {spinner(' downloading…')}
          <Gap />
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{indeterminateMeta(progress)}</Text>
        </>
      ) : (
        <>
          <ProgressBar percent={0} />
          <Gap />
          {spinner(refreshing ? ' link expired — grabbing a fresh one…' : ' starting download…')}
        </>
      )}
    </Box>
  )
}
