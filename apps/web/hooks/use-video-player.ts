'use client'

import Hls, { type Level } from 'hls.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useReviewStore } from '@/stores/review-store'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QualityLevel {
  index: number
  height: number
  bitrate: number
  label: string
}

export interface VideoPlayerControls {
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
  setPlaybackRate: (rate: number) => void
  setQuality: (levelIndex: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleFullscreen: (containerEl: HTMLElement) => void
}

export interface VideoPlayerState {
  isPlaying: boolean
  currentTime: number
  duration: number
  buffered: number
  volume: number
  isMuted: boolean
  playbackRate: number
  qualityLevels: QualityLevel[]
  currentQuality: number
  isLoading: boolean
  isFullscreen: boolean
  error: string | null
}

export interface UseVideoPlayerReturn extends VideoPlayerControls, VideoPlayerState {
  videoRef: React.RefObject<HTMLVideoElement>
  hlsRef: React.RefObject<Hls | null>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseVideoPlayerOptions {
  /**
   * Compare panes: don't touch global review-store signals
   * (seekTarget / playheadTime / activeAnnotation).
   *
   * §107 — the store holds ONE playhead and ONE seek target. Two compare
   * players both writing them would fight: each would broadcast its own
   * position as the page's, and each would obey a seek meant for the other.
   * Detached players are driven entirely by useSyncedTransport instead.
   */
  detached?: boolean
}

export function useVideoPlayer(
  src: string | null,
  options?: UseVideoPlayerOptions,
): UseVideoPlayerReturn {
  const detached = options?.detached === true
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { setPlayheadTime, seekTarget, setActiveAnnotation } = useReviewStore()

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolumeState] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([])
  const [currentQuality, setCurrentQuality] = useState(-1) // -1 = auto
  const [isLoading, setIsLoading] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync playhead to store at ~4fps to avoid excessive re-renders
  useEffect(() => {
    if (detached) return
    syncIntervalRef.current = setInterval(() => {
      const video = videoRef.current
      if (video && !video.paused) {
        setPlayheadTime(video.currentTime)
      }
    }, 250)
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
    }
  }, [setPlayheadTime, detached])

  // React to external seek requests (e.g. clicking comment timecode)
  useEffect(() => {
    if (detached) return
    if (!seekTarget) return
    const video = videoRef.current
    if (!video) return
    const dur = video.duration
    // Allow seek even if duration isn't fully resolved yet (NaN/0)
    if (dur && Number.isFinite(dur)) {
      const clamped = Math.max(0, Math.min(seekTarget.time, dur))
      video.currentTime = clamped
      setCurrentTime(clamped)
      if (seekTarget.pause) {
        video.pause()
        setIsPlaying(false)
      }
    } else {
      // Queue seek for after metadata loads
      const onLoaded = () => {
        const d = video.duration
        if (d && Number.isFinite(d)) {
          const clamped = Math.max(0, Math.min(seekTarget.time, d))
          video.currentTime = clamped
          setCurrentTime(clamped)
          if (seekTarget.pause) {
            video.pause()
            setIsPlaying(false)
          }
        }
        video.removeEventListener('loadedmetadata', onLoaded)
      }
      video.addEventListener('loadedmetadata', onLoaded)
      return () => video.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [seekTarget, detached])

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // HLS + video element setup
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    setError(null)
    setIsLoading(true)

    const onLoadedMetadata = () => {
      setDuration(video.duration)
      setIsLoading(false)
    }

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime)
      // Update buffered end
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1))
      }
    }

    const onPlay = () => { setIsPlaying(true); if (!detached) setActiveAnnotation(null) }
    const onPause = () => setIsPlaying(false)
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)
    const onVolumeChange = () => {
      setVolumeState(video.volume)
      setIsMuted(video.muted)
    }
    const onEnded = () => {
      setIsPlaying(false)
      if (!detached) setPlayheadTime(video.duration)
    }
    const onError = () => {
      setIsLoading(false)
      setError('Video playback error')
    }
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1))
      }
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onError)
    video.addEventListener('progress', onProgress)

    const isHlsSource = src.includes('.m3u8')
    // §117 — NATIVE HLS WINS WHERE IT EXISTS, and the order here is the whole
    // point.
    //
    // This used to check Hls.isSupported() first. Measured in Safari 26.5.2:
    // isSupported() is true (desktop Safari has MSE), canPlayType(
    // 'application/vnd.apple.mpegurl') is "maybe", and the branch taken was
    // hls.js — so the native fallback below was unreachable in the one
    // browser that has a native HLS player at all.
    //
    // That matters because our segments are MPEG-TS (the ffmpeg hls muxer's
    // default). Safari's MSE will not accept TS, so hls.js has to transmux to
    // fMP4 in JS and append through SourceBuffer — the fragile path, and the
    // one that produced `HLS error: mediaError` in Safari while Chromium
    // played the same asset fine. Safari's native player reads TS directly.
    //
    // Chromium is unaffected: canPlayType returns "" there, so it still gets
    // hls.js exactly as before.
    //
    // The cost, stated rather than hidden: native playback exposes no level
    // list, so the quality picker does not render in Safari and ABR is left
    // to the browser. Playing at all beats choosing a rendition.
    const nativeHls = isHlsSource && Boolean(video.canPlayType('application/vnd.apple.mpegurl'))

    if (nativeHls) {
      video.src = src
    } else if (isHlsSource && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
      })
      hlsRef.current = hls
      hls.loadSource(src)
      hls.attachMedia(video)

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const levels: QualityLevel[] = data.levels.map((level: Level, index: number) => ({
          index,
          height: level.height,
          bitrate: level.bitrate,
          label: level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}kbps`,
        }))
        setQualityLevels(levels)
        setCurrentQuality(-1) // start on auto
        setIsLoading(false)
      })

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          // `details` names the actual failure (bufferAppendError,
          // fragParsingError, manifestLoadError...). The type alone —
          // "mediaError" — was what every report of this arrived with, and it
          // does not distinguish a codec Safari's MSE refuses from a segment
          // that never loaded.
          setError(`HLS error: ${data.type}${data.details ? ` (${data.details})` : ''}`)
          setIsLoading(false)
        }
      })

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        setCurrentQuality(data.level)
      })
    } else {
      // Direct URL (mp4, mp3, etc.) — and any HLS source in a browser with
      // neither native support nor MSE, where this is the only thing left to
      // try. The native-HLS case is handled first, above.
      video.src = src
    }

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onError)
      video.removeEventListener('progress', onProgress)

      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src, setPlayheadTime])

  // ─── Controls ───────────────────────────────────────────────────────────────

  const play = useCallback(() => {
    videoRef.current?.play().catch(() => {
      // Autoplay may be blocked; ignore
    })
  }, [])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [])

  const seek = useCallback((time: number) => {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(time, video.duration || 0))
    video.currentTime = clamped
    setCurrentTime(clamped)
    if (!detached) setPlayheadTime(clamped)
  }, [setPlayheadTime, detached])

  const setPlaybackRate = useCallback((rate: number) => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = rate
    setPlaybackRateState(rate)
  }, [])

  const setQuality = useCallback((levelIndex: number) => {
    const hls = hlsRef.current
    if (!hls) return
    hls.currentLevel = levelIndex // -1 = auto
    setCurrentQuality(levelIndex)
  }, [])

  const setVolume = useCallback((vol: number) => {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(1, vol))
    video.volume = clamped
    video.muted = clamped === 0
  }, [])

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }, [])

  const toggleFullscreen = useCallback((containerEl: HTMLElement) => {
    if (!document.fullscreenElement) {
      containerEl.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  return {
    videoRef,
    hlsRef,
    // state
    isPlaying,
    currentTime,
    duration,
    buffered,
    volume,
    isMuted,
    playbackRate,
    qualityLevels,
    currentQuality,
    isLoading,
    isFullscreen,
    error,
    // controls
    play,
    pause,
    togglePlay,
    seek,
    setPlaybackRate,
    setQuality,
    setVolume,
    toggleMute,
    toggleFullscreen,
  }
}
