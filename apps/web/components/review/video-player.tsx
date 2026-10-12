"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
  ChevronUp,
  Check,
  Repeat,
  Captions,
  Settings,
} from "lucide-react";
import {
  cn,
  formatTime,
  formatTimecode,
  formatFrames,
  languageLabel,
} from "@/lib/utils";
import { api } from "@/lib/api";
import { useReviewStore, type TimeFormat } from "@/stores/review-store";
import { useVideoPlayer } from "@/hooks/use-video-player";
import { useReview } from "./review-provider";
import { ProgressBar } from "./progress-bar";
import { LutCanvas } from "./lut-canvas";
import { PlayerSettingsSheet } from "./player-settings-sheet";
import { useOptionalToast } from "@/components/shared/toast";
import type { ParsedCube } from "@/lib/lut/cube-parser";
import type { Comment } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StreamUrlResponse {
  url: string;
}

interface VideoPlayerProps {
  assetId: string;
  comments?: Comment[];
  overlay?: React.ReactNode;
  className?: string;
  /** Pre-fetched stream URL (for share mode — skips authenticated API call) */
  initialStreamUrl?: string | null;
  /**
   * Absolute URL to captions.vtt, or null when transcription hasn't
   * finished (or failed). The CC button is hidden entirely while null —
   * a toggle that can't do anything is worse than no toggle.
   *
   * Note: no crossOrigin is set on the <video>. In production the API is
   * served same-origin under /api, so the track fetch needs no CORS. Adding
   * crossOrigin="anonymous" would also apply to the native-HLS/progressive
   * `video.src` path in use-video-player.ts, which is a real playback risk
   * for a cosmetic dev-only gain.
   */
  captionsUrl?: string | null;
  /** ISO 639-1 code from Whisper's auto-detection, for <track srclang>. */
  captionsLanguage?: string | null;
  /**
   * Parsed LUT for non-destructive preview. When set, the real <video>
   * stays in the DOM (hls.js, audio and all playback state keep running
   * against it untouched) but is made invisible, and a WebGL canvas is
   * laid over the identical box. Because the canvas occupies exactly the
   * <video>'s layout box, VideoFrameConstraint's annotation overlay --
   * which measures that box -- keeps lining up unmodified.
   */
  cube?: ParsedCube | null;
  /** Picker element rendered into the transport bar. */
  lutPicker?: React.ReactNode;
  /**
   * §228 — the phone transport row: play/pause, the timecode, the scrubber
   * (which is its own row above) and fullscreen, with loop, speed,
   * captions, quality and the LUT moved into a `⚙` bottom sheet.
   *
   * A PROP, not a media query inside this component, for one reason: the
   * public share viewer (`components/share/share-player.tsx`) mounts this
   * same player and is explicitly out of §228's scope. It passes nothing,
   * so it keeps today's row at every width. The dashboard asset page
   * passes `useIsPhone()`.
   */
  compactControls?: boolean;
  /**
   * The LUT library, rendered as a sub-page of the settings sheet when
   * `compactControls` is set. On a phone the desktop's 260px LUT column
   * would leave the frame 130px wide, so the picker goes in the sheet and
   * `lutPicker` is left unset. Same `useLut` state either way.
   */
  lutSheetContent?: React.ReactNode;
  /** Name of the selected LUT, for the sheet's LUT row. */
  lutLabel?: string | null;
}

// ─── Video frame constraint ──────────────────────────────────────────────────

/**
 * Wraps children so they are positioned exactly over the visible video frame,
 * excluding the black letterbox bars created by object-contain.
 *
 * Exported for the compare overlay (§107), which mounts its own <video> per
 * pane and needs annotations to land in the SAME coordinate space the normal
 * player authors them in. A second measurement implementation would put a
 * drawing in a different place depending on which viewer opened it.
 */
export function VideoFrameConstraint({
  videoRef,
  children,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  children: React.ReactNode;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const calc = () => {
      const container = video.parentElement;
      if (!container) return;

      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const vw = video.videoWidth;
      const vh = video.videoHeight;

      if (!vw || !vh) {
        // Video metadata not loaded yet — fill container
        setStyle({ position: "absolute", inset: 0 });
        return;
      }

      const containerAspect = cw / ch;
      const videoAspect = vw / vh;

      let renderW: number, renderH: number, offsetX: number, offsetY: number;

      if (videoAspect > containerAspect) {
        // Video wider than container — letterbox top/bottom
        renderW = cw;
        renderH = cw / videoAspect;
        offsetX = 0;
        offsetY = (ch - renderH) / 2;
      } else {
        // Video taller than container — letterbox left/right
        renderH = ch;
        renderW = ch * videoAspect;
        offsetX = (cw - renderW) / 2;
        offsetY = 0;
      }

      setStyle({
        position: "absolute",
        left: offsetX,
        top: offsetY,
        width: renderW,
        height: renderH,
      });
    };

    calc();
    video.addEventListener("loadedmetadata", calc);
    video.addEventListener("resize", calc);

    const ro = new ResizeObserver(calc);
    if (video.parentElement) ro.observe(video.parentElement);

    return () => {
      video.removeEventListener("loadedmetadata", calc);
      video.removeEventListener("resize", calc);
      ro.disconnect();
    };
  }, [videoRef]);

  return (
    <div ref={wrapperRef} style={style} className="overflow-hidden">
      {children}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Prepend the API origin to a relative stream URL; leave absolute ones alone.
 *
 * Re-exported, not reimplemented: this player is the ONE place a stream URL
 * may be resolved (CLAUDE.md §32) — anything that resolves before handing a
 * URL here produces `/api/api/stream/...` and a 404. Callers and tests
 * should reference this rather than writing the rule out again; it was
 * previously inline twice in the effect below, and a third copy in a test
 * is what let a mutation of the real logic go unnoticed. It now lives in
 * lib/utils beside resolveApiMediaUrl, which is the same rule.
 */
export { resolveStreamUrl } from "@/lib/utils";
import { resolveStreamUrl } from "@/lib/utils";

export function VideoPlayer({
  assetId,
  comments = [],
  overlay,
  className,
  initialStreamUrl,
  captionsUrl,
  captionsLanguage,
  cube,
  lutPicker,
  compactControls,
  lutSheetContent,
  lutLabel,
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { isDrawingMode, timeFormat, setTimeFormat, setPlayheadTime, currentVersion } =
    useReviewStore();
  const { registerPauseHandler, isLoading: reviewLoading, asset } = useReview();
  // §118 — the asset's existing grid thumbnail, shown until the first frame
  // decodes. Safari's native HLS path takes ~1.2s to produce a real frame
  // (measured) and showed solid black for that whole gap; the image was
  // already generated and already being served in the project grid, so
  // nothing new is fetched or stored for this.
  const posterUrl = asset?.thumbnail_url ? resolveStreamUrl(asset.thumbnail_url) : undefined;
  // The version the review provider actually selected -- the newest READY
  // one, which is not necessarily the newest one (§117).
  const versionId = currentVersion?.id ?? null;
  const [timeFormatOpen, setTimeFormatOpen] = useState(false);
  const timeFormatRef = useRef<HTMLDivElement>(null);

  // Close time format dropdown on outside click
  useEffect(() => {
    if (!timeFormatOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        timeFormatRef.current &&
        !timeFormatRef.current.contains(e.target as Node)
      )
        setTimeFormatOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [timeFormatOpen]);

  function displayTime(seconds: number): string {
    switch (timeFormat) {
      case "frames":
        return formatFrames(seconds);
      case "standard":
        return formatTime(seconds);
      case "timecode":
        return formatTimecode(seconds);
      default:
        return formatTimecode(seconds);
    }
  }

  // Load the stream URL — reset immediately on asset change so the old video
  // doesn't keep playing while the new URL is being fetched.
  //
  // §117 — the version_id is REQUIRED, not an optimisation. Without it the
  // endpoint falls back to the highest version_number with no ready-status
  // filter (assets.py) and 409s when that one is still processing, while the
  // review provider's "current version" is the newest READY one. The two
  // disagree exactly when a new version is uploading, which is when someone
  // is most likely to be watching — and the 409 surfaced as a blank player,
  // because the empty catch below left streamUrl null forever and
  // useVideoPlayer(null) has nothing to report an error about.
  useEffect(() => {
    let ignore = false;
    setStreamUrl(null);
    setStreamError(null);
    if (initialStreamUrl) {
      setStreamUrl(resolveStreamUrl(initialStreamUrl));
      return;
    }
    // Wait for the provider to resolve a version rather than firing a
    // version-less request first: that request is the one that 409s, and
    // asking for "whatever is newest" is never what this player wants.
    if (!versionId) {
      // Still resolving which version to play. Only once the provider has
      // finished and produced none is this a real dead end worth showing.
      if (!reviewLoading) setStreamError("No playable version of this asset.");
      return;
    }
    api
      .get<StreamUrlResponse>(`/assets/${assetId}/stream?version_id=${versionId}`)
      .then((data) => {
        if (ignore) return;
        setStreamUrl(resolveStreamUrl(data.url));
      })
      .catch((err) => {
        if (ignore) return;
        // A real, visible state. The previous empty catch claimed errors were
        // "handled by player error state", which was not true of a fetch that
        // never produced a src for the player to fail on.
        setStreamError(
          err && typeof err === "object" && "status" in err && err.status === 409
            ? "This version is still processing."
            : "Could not load this video.",
        );
      });
    return () => {
      ignore = true;
    };
  }, [assetId, initialStreamUrl, versionId, reviewLoading]);

  const player = useVideoPlayer(streamUrl);

  const {
    videoRef,
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
    fullscreenMode,
    error,
    pause,
    togglePlay,
    seek,
    setPlaybackRate,
    setQuality,
    setVolume,
    toggleMute,
    toggleFullscreen,
  } = player;

  // Register pause handler with review provider
  useEffect(() => {
    registerPauseHandler(pause);
  }, [registerPauseHandler, pause]);

  // Sync video currentTime to review store so comment input shows same timecode
  const lastSyncRef = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastSyncRef.current > 100) {
      setPlayheadTime(currentTime);
      lastSyncRef.current = now;
    }
  }, [currentTime, setPlayheadTime]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        isDrawingMode
      ) {
        return;
      }

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(currentTime - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(currentTime + 5);
          break;
        case "KeyJ":
          seek(currentTime - 10);
          break;
        case "KeyK":
          togglePlay();
          break;
        case "KeyL":
          seek(currentTime + 10);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, seek, currentTime, isDrawingMode]);

  const handleContainerClick = useCallback(() => {
    if (!isDrawingMode) {
      togglePlay();
    }
  }, [togglePlay, isDrawingMode]);

  /**
   * §228c item 5 — fullscreen, and what it costs on an iPhone.
   *
   * `toggleFullscreen` returns the API it used. 'video-native' is the
   * iPhone: iOS takes the <video> into its OWN player, which draws none of
   * this component — no transport row, no timestamped comments, no
   * annotation overlay, and no graded preview, because the LUT is a WebGL
   * canvas painted OVER the video and the native player shows the video.
   *
   * With HLS that is the only part that changes: hls.js stays attached to
   * the same element, so the same stream keeps playing from the same
   * position at the same quality, and coming back out of the native player
   * returns to our controls with the playhead where iOS left it.
   *
   * So rather than silently dropping the grade, say so. Only when a LUT is
   * actually selected (`cube`), and only on the path where it is true.
   */
  const toast = useOptionalToast();
  const handleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    const used = toggleFullscreen(containerRef.current);
    if (used === "video-native" && cube) {
      toast("LUT not shown in iPhone fullscreen", "info", 4000);
    }
  }, [toggleFullscreen, cube, toast]);

  // The canvas needs the video's intrinsic size, and reading videoRef in
  // JSX would never re-render when it populates. Tracked in state instead,
  // refreshed on the same events VideoFrameConstraint listens to.
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      if (video.videoWidth && video.videoHeight) {
        setVideoDims({ w: video.videoWidth, h: video.videoHeight });
      }
    };
    update();
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    return () => {
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
    };
  }, [videoRef, streamUrl]);

  // Drive the TextTrack's mode directly. React renders <track> but does not
  // control its `mode`, and the browser defaults a non-`default` track to
  // "disabled" — which means the cues are never even parsed until this runs.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const track = video.textTracks?.[0];
    if (!track) return;
    track.mode = captionsOn ? "showing" : "hidden";
  }, [captionsOn, captionsUrl, videoRef]);

  // A new asset (or a transcript that just finished) starts with captions
  // off rather than inheriting the previous asset's toggle state.
  useEffect(() => {
    setCaptionsOn(false);
  }, [assetId]);

  const handleSpeedCycle = useCallback(() => {
    const idx = SPEED_OPTIONS.indexOf(
      playbackRate as (typeof SPEED_OPTIONS)[number],
    );
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    setPlaybackRate(next);
  }, [playbackRate, setPlaybackRate]);

  /**
   * The timecode readout and its format picker.
   *
   * Lifted into a variable in §228 so the compact phone row and the
   * unchanged desktop row render the SAME control rather than two copies
   * that can drift — the markup below is character-for-character what the
   * desktop row held before, which is what keeps that row pixel-identical.
   */
  const timeReadout = (
    <>
      {timeFormat === "timecode" ? (
        displayTime(currentTime)
      ) : (
        <>
          {displayTime(currentTime)}{" "}
          <span className="text-text-tertiary">/</span>{" "}
          {displayTime(duration)}
        </>
      )}
    </>
  );

  const timecodeControl = (
    <div className="relative" ref={timeFormatRef}>
      {compactControls ? (
        /* §228b item 3c — "the timecode box (text and padding) smaller".
           The BUTTON is the full 44px height of the compact row, so its
           hit area overlaps neither the scrubber above nor the tab switch
           below; the chip it paints is 28px tall with 12px text and half
           the horizontal padding. Measured at 390px: 138x44 before,
           100x28 painted after. */
        <button
          onClick={() => setTimeFormatOpen((p) => !p)}
          data-testid="player-timecode"
          aria-label="Time format"
          className="flex h-11 items-center"
        >
          <span className="flex h-7 items-center gap-1 rounded-md bg-bg-tertiary px-2">
            <span className="font-mono text-xs text-text-primary tabular-nums tracking-wide">
              {timeReadout}
            </span>
            <ChevronUp
              className={cn(
                "h-3 w-3 text-text-tertiary transition-transform",
                timeFormatOpen && "rotate-180",
              )}
            />
          </span>
        </button>
      ) : (
      <button
        onClick={() => setTimeFormatOpen((p) => !p)}
        data-testid="player-timecode"
        // §228 — `hover-none:h-11`: on a phone this is the one readout in
        // the compact row and it opens the format menu, so it has to be a
        // real target. A mouse sees the 28px control unchanged.
        className="flex items-center gap-1.5 rounded-md bg-bg-tertiary px-3 py-1 hover-none:h-11 hover:bg-bg-hover transition-colors"
      >
        <span className="font-mono text-sm text-text-primary tabular-nums tracking-wide">
          {timeReadout}
        </span>
        <ChevronUp
          className={cn(
            "h-3 w-3 text-text-tertiary transition-transform",
            timeFormatOpen && "rotate-180",
          )}
        />
      </button>
      )}
      {timeFormatOpen && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-48 rounded-xl border border-white/10 bg-[#2a2a30] shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100">
          <div className="px-3 py-2 text-[11px] text-text-tertiary uppercase tracking-wider font-medium">
            Time Format
          </div>
          {(
            [
              { id: "frames" as TimeFormat, label: "Frames" },
              { id: "standard" as TimeFormat, label: "Standard" },
              { id: "timecode" as TimeFormat, label: "Timecode" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={cn(
                "flex w-full items-center justify-between px-3 py-2 hover-none:min-h-11 text-[13px] transition-colors",
                timeFormat === item.id
                  ? "text-text-primary"
                  : "text-text-secondary hover:bg-white/5",
              )}
              onClick={() => {
                setTimeFormat(item.id);
                setTimeFormatOpen(false);
              }}
            >
              {item.label}
              {timeFormat === item.id && (
                <Check className="h-4 w-4 text-accent" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col h-full w-full",
        // §228c item 5 — NOT on the iPhone's path. `fixed inset-0 z-50`
        // assumes THIS element is the one the browser blew up to fill the
        // screen; on iOS it never is — the <video> is, inside a player
        // drawn by the system on top of the page. Pinning this container
        // over the whole page while that happens leaves it covering the
        // viewer underneath once iOS's player closes over it.
        isFullscreen && fullscreenMode !== "video-native" && "fixed inset-0 z-50",
        className,
      )}
    >
      {/* Video area — fills available space, object-contain preserves aspect ratio with letterbox */}
      <div
        className="flex-1 relative min-h-0 bg-black overflow-hidden cursor-pointer"
        onClick={handleContainerClick}
      >
        <video
          ref={videoRef}
          className={cn(
            "absolute inset-0 w-full h-full object-contain",
            isDrawingMode ? "pointer-events-none" : "",
            // Invisible, not unmounted: it remains the decode/audio source
            // and hls.js stays attached. `invisible` also preserves the
            // layout box VideoFrameConstraint measures.
            cube ? "invisible" : "",
          )}
          playsInline
          preload="metadata"
          // §228 — the `loop` state existed and the Loop button toggled it,
          // but NOTHING ever applied it to the element: the control has been
          // decorative since it was added (the audio player's equivalent is
          // wired, through its `finish` handler). Found while moving Loop
          // into the settings sheet, where a row that does nothing would be
          // worse than the obscure icon it replaces. Default is `false`, so
          // this changes nothing for anyone who never pressed it.
          loop={loop}
          // Deliberately not cleared once playback starts: the browser drops
          // the poster itself on the first decoded frame, and keeping it lets
          // the same image return if the element is re-seeked to an
          // undecoded position.
          poster={posterUrl}
        >
          {captionsUrl && (
            <track
              key={captionsUrl}
              kind="subtitles"
              src={captionsUrl}
              srcLang={captionsLanguage || "und"}
              label={
                captionsLanguage
                  ? languageLabel(captionsLanguage)
                  : "Captions"
              }
            />
          )}
        </video>

        {/* Graded preview, drawn over the exact box the <video> occupies */}
        {cube && videoDims && (
          <LutCanvas
            source={videoRef.current}
            cube={cube}
            width={videoDims.w}
            height={videoDims.h}
            animated
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />
        )}

        {/* Loading spinner */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-10 h-10 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {/* Error state. streamError covers the case the player itself cannot
            report: a stream URL that never arrived, so there is no src for
            useVideoPlayer to fail on and `error` stays null forever. */}
        {(error || streamError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <p className="text-red-400 text-sm">{error || streamError}</p>
          </div>
        )}

        {/* Overlay slot (annotation canvas / overlay) — constrained to video frame */}
        {overlay && (
          <VideoFrameConstraint videoRef={videoRef}>
            {overlay}
          </VideoFrameConstraint>
        )}
      </div>

      {/* Progress bar */}
      <div className="shrink-0 bg-bg-primary">
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          comments={comments}
          streamUrl={streamUrl}
          onSeek={seek}
        />
      </div>

      {/* ─── Bottom transport bar ───────────────────────────────────────
          §228 — two rows, chosen by the `compactControls` prop, not by a
          media query in here: the public share viewer mounts this same
          player and is out of scope, so it keeps the desktop row at every
          width. The desktop row below is untouched. */}
      {compactControls ? (
        <div
          data-testid="video-transport-compact"
          // §228b item 3c — h-11 (44px), down from h-14 (56px), and the
          // icons down from 20px to 16px. 44 and not the ~32 the owner
          // asked for: play/pause is on the primary list and keeps 44x44,
          // and a 44px hit area inside a 32px row has to take 6px from the
          // scrubber above (itself a seek target) or from the tab switch
          // below. Everything that CAN shrink has: the icons, the timecode
          // chip (28px painted) and the row's padding.
          className="flex items-center justify-between h-11 px-1 bg-bg-secondary/80 border-t border-border shrink-0"
        >
          <button
            onClick={togglePlay}
            data-testid="player-play-pause"
            // Primary: 44x44, unchanged.
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-primary hover:bg-bg-hover transition-colors shrink-0"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>

          {timecodeControl}

          <div className="flex items-center shrink-0">
            {/* 36x44, not 44x44: secondary controls on the 36px floor
                (item 3g). They sit side by side, so the width is where the
                room comes from and neither one's hit area reaches the
                other's. */}
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Player settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              data-testid="player-settings-button"
              className="flex h-11 w-9 items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <Settings className="h-4 w-4" />
            </button>
            {/* §228c item 5 — not drawn at all where there is no API to
                call. A button that cannot work is worse than a missing
                one: the owner pressed this one and nothing happened. */}
            {fullscreenMode !== "none" && (
              <button
                onClick={handleFullscreen}
                data-testid="player-fullscreen"
                className="flex h-11 w-9 items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              >
                {isFullscreen ? (
                  <Minimize className="h-4 w-4" />
                ) : (
                  <Maximize className="h-4 w-4" />
                )}
              </button>
            )}
          </div>
        </div>
      ) : (
      <div className="flex items-center justify-between h-12 px-4 bg-bg-secondary/80 border-t border-border shrink-0">
        {/* Left: Play, Loop, Speed, Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={togglePlay}
            className="flex h-7 w-7 hover-none:h-11 hover-none:w-11 items-center justify-center rounded text-text-primary hover:bg-bg-hover transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>

          <button
            onClick={() => setLoop((p) => !p)}
            className={cn(
              "flex h-7 w-7 hover-none:h-11 hover-none:w-11 items-center justify-center rounded transition-colors",
              loop
                ? "text-accent bg-accent/10"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover",
            )}
            aria-label="Loop"
          >
            <Repeat className="h-4 w-4" />
          </button>

          <button
            onClick={handleSpeedCycle}
            className="flex h-7 hover-none:h-11 hover-none:min-w-11 items-center justify-center rounded px-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors tabular-nums"
            aria-label="Playback speed"
          >
            {playbackRate}x
          </button>

          <button
            onClick={toggleMute}
            // §228 — `hover-none:hidden`: on a touch device the hardware
            // volume buttons own this, and the row needs the room more than
            // it needs a mute toggle. A media feature, not a width
            // breakpoint, so a mouse at any size still sees it exactly as
            // before and the desktop row stays pixel-identical.
            className="flex h-7 w-7 hover-none:h-11 hover-none:w-11 items-center justify-center rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors hover-none:hidden"
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Center: Timecode display with format picker */}
        {timecodeControl}

        {/* Right: LUT, Captions, Quality, Fullscreen */}
        <div className="flex items-center gap-2">
          {lutPicker}
          {/* Captions toggle — hidden entirely until a transcript exists */}
          {captionsUrl && (
            <button
              onClick={() => setCaptionsOn((on) => !on)}
              className={cn(
                // §185 — px-1 to match the LUT button's trimmed footprint
                // (§184). With Quality now rendering on BOTH paths, this row
                // holds four controls where only three were ever visible
                // together before: LUT, Captions, Quality, Fullscreen. The
                // row's own gap-2 is left alone so the spacing between all
                // four stays uniform; it is the buttons that give ground.
                "flex h-7 hover-none:h-11 hover-none:min-w-11 items-center justify-center rounded px-1 text-xs font-medium border transition-colors shrink-0",
                captionsOn
                  ? "border-accent text-accent"
                  : "border-border text-text-tertiary hover:text-text-primary hover:bg-bg-hover",
              )}
              aria-label={captionsOn ? "Hide captions" : "Show captions"}
              aria-pressed={captionsOn}
              title={
                captionsLanguage
                  ? `Captions (${languageLabel(captionsLanguage)})`
                  : "Captions"
              }
            >
              <Captions className="h-4 w-4" />
            </button>
          )}

          {/* Quality selector */}
          {qualityLevels.length > 0 && (
            <select
              value={currentQuality}
              onChange={(e) => setQuality(parseInt(e.target.value, 10))}
              className="bg-transparent text-text-secondary text-xs border border-border rounded px-1.5 py-1 hover-none:h-11 cursor-pointer shrink-0 hover:text-text-primary transition-colors"
              aria-label="Quality"
            >
              <option value={-1} className="bg-bg-secondary">
                Auto
              </option>
              {qualityLevels.map((level) => (
                <option
                  key={level.index}
                  value={level.index}
                  className="bg-bg-secondary"
                >
                  {level.label}
                </option>
              ))}
            </select>
          )}

          {/* Fullscreen. §228c item 5 — same rule as the compact row: no
              API, no button. */}
          {fullscreenMode !== "none" && (
            <button
              onClick={handleFullscreen}
              data-testid="player-fullscreen-wide"
              className="flex h-7 w-7 hover-none:h-11 hover-none:w-11 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>
      )}

      {/* The phone settings sheet. Mounted here because this component owns
          every piece of state it edits — loop, captionsOn, playbackRate and
          the HLS quality level — so nothing is lifted or duplicated. */}
      {compactControls && (
        <PlayerSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          playbackRate={playbackRate}
          speedOptions={SPEED_OPTIONS}
          onPlaybackRate={setPlaybackRate}
          loop={loop}
          onToggleLoop={() => setLoop((p) => !p)}
          captionsAvailable={Boolean(captionsUrl)}
          captionsOn={captionsOn}
          onToggleCaptions={() => setCaptionsOn((on) => !on)}
          captionsLanguageLabel={
            captionsLanguage ? languageLabel(captionsLanguage) : null
          }
          qualityLevels={qualityLevels}
          currentQuality={currentQuality}
          onQuality={setQuality}
          lutSubPage={lutSheetContent}
          lutLabel={lutLabel ?? null}
        />
      )}
    </div>
  );
}
