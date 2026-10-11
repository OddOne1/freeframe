/**
 * The audio player's phone transport row (§228 A6).
 *
 * The untouched row overflowed a 390px screen: play, loop, speed and mute
 * on the left, a timecode readout in the middle and a `w-[140px]` spacer
 * on the right — a spacer that existed only to centre the readout — came
 * to 420px of content in a 390px box. The compact row drops the spacer
 * and moves speed and loop into the same settings sheet the video player
 * uses, which is where the owner asked for them.
 *
 * WaveSurfer is stubbed: it needs Web Audio and a real decode, neither of
 * which jsdom has. Everything this asserts is above that line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

const setPlaybackRate = vi.fn()

vi.mock('wavesurfer.js', () => ({
  default: {
    create: () => ({
      on: () => {},
      load: () => {},
      destroy: () => {},
      setVolume: () => {},
      setPlaybackRate: setPlaybackRate,
      playPause: () => {},
      seekTo: () => {},
      getDuration: () => 60,
    }),
  },
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ url: '/stream/a.wav' })) },
  ApiError: class extends Error {},
}))

vi.mock('../review-provider', async () => {
  const React = await import('react')
  return {
    ReviewProvider: ({ children }: { children: React.ReactNode }) => children,
    useReview: () => ({ shareToken: undefined, shareSession: null }),
  }
})
vi.mock('../progress-bar', () => ({ ProgressBar: () => <div data-testid="progress-bar" /> }))

import { AudioPlayer } from '../audio-player'

const asset = { id: 'a1', name: 'take.wav', asset_type: 'audio' } as never
const version = { id: 'v1', asset_id: 'a1', version_number: 1, processing_status: 'ready', created_by: null, created_at: '', deleted_at: null, files: [] } as never

beforeEach(() => setPlaybackRate.mockClear())

describe('§228 — the audio player on a phone', () => {
  it('keeps play and the timecode, and drops the fixed 140px spacer', () => {
    const { container } = render(
      <AudioPlayer asset={asset} version={version} compactControls />,
    )
    const row = screen.getByTestId('audio-transport-compact')
    expect(within(row).getByLabelText('Play')).toBeTruthy()
    expect(within(row).getByLabelText('Player settings')).toBeTruthy()
    // The spacer that made this row wider than a 390px phone.
    expect(container.querySelector('.w-\\[140px\\]')).toBeNull()
  })

  it('and moves loop, speed and the mute toggle out of the row', () => {
    render(<AudioPlayer asset={asset} version={version} compactControls />)
    const row = screen.getByTestId('audio-transport-compact')
    expect(within(row).queryByTitle('Loop')).toBeNull()
    expect(within(row).queryByTitle('Playback speed')).toBeNull()
    expect(within(row).queryByTitle('Mute')).toBeNull()
  })

  it('speed and loop are in the sheet, and speed reaches wavesurfer', async () => {
    render(<AudioPlayer asset={asset} version={version} compactControls />)
    fireEvent.click(screen.getByTestId('player-settings-button'))
    const sheet = await screen.findByTestId('player-settings-sheet')
    expect(within(sheet).getByTestId('sheet-row-loop')).toBeTruthy()
    fireEvent.click(within(sheet).getByTestId('sheet-row-speed'))
    fireEvent.click(await screen.findByText('2x'))
    await waitFor(() => expect(setPlaybackRate).toHaveBeenCalledWith(2))
  })

  it('and the sheet has no captions, quality or LUT row — audio has none', async () => {
    render(<AudioPlayer asset={asset} version={version} compactControls />)
    fireEvent.click(screen.getByTestId('player-settings-button'))
    const sheet = await screen.findByTestId('player-settings-sheet')
    expect(within(sheet).queryByTestId('sheet-row-captions')).toBeNull()
    expect(within(sheet).queryByTestId('sheet-row-quality')).toBeNull()
    expect(within(sheet).queryByTestId('sheet-row-lut')).toBeNull()
  })

  it('while without the prop the desktop row is exactly what it was', () => {
    const { container } = render(<AudioPlayer asset={asset} version={version} />)
    expect(screen.queryByTestId('audio-transport-compact')).toBeNull()
    expect(screen.getByTitle('Loop')).toBeTruthy()
    expect(screen.getByTitle('Playback speed')).toBeTruthy()
    expect(container.querySelector('.w-\\[140px\\]')).toBeTruthy()
  })
})
