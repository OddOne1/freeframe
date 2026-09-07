/**
 * §127 — the per-file transcription toggle and the live progress bar.
 *
 * The toggle is INTENT ("should this file end up transcribed"), not a
 * trigger, and "off" means two different things depending on whether a run
 * is in flight — so the panel has to say which.
 *
 * The progress bar's flat start is real and expected: the model load and
 * the VAD pre-filter both finish before faster-whisper yields its first
 * segment, so 0% is "not there yet", not "stuck". The copy says so, because
 * the alternative is someone reloading to check.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TranscriptPanel } from '../transcript-panel'
import type { TranscriptResponse } from '@/types'

const base: TranscriptResponse = {
  transcription_status: 'not_started',
  transcription_progress: null,
  transcription_enabled: true,
  language: null,
  captions_url: null,
  text: '',
  segments: [],
}

const panel = (t: Partial<TranscriptResponse>, onToggle?: (v: boolean) => void) =>
  render(
    <TranscriptPanel
      transcript={{ ...base, ...t }}
      isLoading={false}
      currentTime={0}
      onSeek={vi.fn()}
      onToggle={onToggle}
    />,
  )

describe('the toggle', () => {
  it('reflects the file’s current setting', () => {
    panel({ transcription_enabled: false }, vi.fn())
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('asks for the opposite of what it currently is', async () => {
    const onToggle = vi.fn()
    panel({ transcription_enabled: true, transcription_status: 'ready', segments: [] }, onToggle)
    await userEvent.click(screen.getByRole('switch'))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('says that turning it off will STOP a run in flight', () => {
    // Off means "cancel this" here and "don't bother later" elsewhere. A
    // single label for both would be wrong in one of the two cases.
    panel({ transcription_status: 'processing', transcription_progress: 12 }, vi.fn())
    expect(screen.getByText(/turning this off stops it/i)).toBeInTheDocument()
  })

  it('does not claim a run is in flight when none is', () => {
    panel({ transcription_status: 'not_started' }, vi.fn())
    expect(screen.queryByText(/turning this off stops it/i)).not.toBeInTheDocument()
  })

  it('is absent for a viewer who cannot change it', () => {
    panel({ transcription_status: 'processing' })
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})

describe('when transcription is off', () => {
  it('says so instead of claiming to be transcribing', () => {
    // Before §127 this state fell through to "Transcribing…" via
    // not_started, which promised work that was never going to happen.
    panel({ transcription_enabled: false, transcription_status: 'not_started' }, vi.fn())
    expect(screen.getByText(/transcription is off/i)).toBeInTheDocument()
    expect(screen.queryByText(/Transcribing…/)).not.toBeInTheDocument()
  })

  it('still shows an existing transcript, since turning it off deletes nothing', () => {
    panel(
      {
        transcription_enabled: false,
        transcription_status: 'ready',
        segments: [{ id: 0, start: 0, end: 1, text: 'hello' }],
      },
      vi.fn(),
    )
    expect(screen.getByText('hello')).toBeInTheDocument()
  })
})

describe('the progress bar', () => {
  it('reports the live percentage', () => {
    panel({ transcription_status: 'processing', transcription_progress: 42 }, vi.fn())
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText(/42%/)).toBeInTheDocument()
  })

  it('explains the flat start rather than showing a bare 0%', () => {
    panel({ transcription_status: 'processing', transcription_progress: 0 }, vi.fn())
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText(/can sit at 0% for a while/i)).toBeInTheDocument()
  })

  it('treats a missing percentage as 0 rather than crashing', () => {
    panel({ transcription_status: 'processing', transcription_progress: null }, vi.fn())
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })
})
