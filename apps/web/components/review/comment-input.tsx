"use client";

import * as React from "react";
import {
  Pencil,
  Paperclip,
  X,
  Loader2,
  Send,
  Smile,
  Clock,
  ChevronLeft,
  ChevronDown,
  MousePointer,
  Square,
  Minus,
  RotateCcw,
  Trash2,
  Globe,
  Lock,
} from "lucide-react";
import { cn, formatTime, formatTimecode, formatFrames } from "@/lib/utils";
import { resolveSubmitTimecode } from "@/lib/resolve-submit-timecode";
import { useReviewStore } from "@/stores/review-store";
import { useReview } from "./review-provider";
import { useDrawing } from "@/hooks/use-drawing";
import { usePhoneChrome, useCompactLandscape } from "@/hooks/use-media-query";
import { api } from "@/lib/api";
import type { User } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommentInputProps {
  assetId: string;
  projectId: string;
  assetType?: string;
  replyToId?: string | null;
  annotationData?: Record<string, unknown> | null;
  onSubmit: (
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotationData?: Record<string, unknown>,
    parentId?: string,
    visibility?: string,
    mentionUserIds?: string[],
  ) => Promise<void>;
  onCancelReply?: () => void;
  onPauseVideo?: () => void;
  /** Compare mode: pane-local playhead seconds; replaces the global store playheadTime. */
  playheadTimeOverride?: number;
  /** Compare mode: hide drawing tools and never attach annotation payloads. */
  disableAnnotations?: boolean;
  /**
   * Compare mode: this input's drawing state, controlled by the parent (which
   * pane is the single active drawing side). When provided it REPLACES the
   * global store `isDrawingMode` for every drawing-UI decision in this input,
   * so only the active pane shows the drawing toolbar and captures the canvas.
   */
  annotationActive?: boolean;
  /** Compare mode: called instead of the global toggle when the pencil / exit is clicked. */
  onToggleAnnotation?: () => void;
  className?: string;
}

// ─── Drawing tools config ─────────────────────────────────────────────────────

const EMOJIS = [
  "👍",
  "👎",
  "❤️",
  "🔥",
  "👀",
  "🎉",
  "😂",
  "😮",
  "😢",
  "💯",
  "✅",
  "❌",
  "⭐",
  "💡",
  "🤔",
  "👏",
];

type DrawingTool = "pen" | "rectangle" | "arrow" | "line";

const DRAW_TOOLS: {
  id: DrawingTool;
  icon: React.ElementType;
  label: string;
}[] = [
  { id: "pen", icon: Pencil, label: "Pencil" },
  { id: "arrow", icon: MousePointer, label: "Arrow" },
  { id: "line", icon: Minus, label: "Line" },
  { id: "rectangle", icon: Square, label: "Rectangle" },
];

const DRAW_COLORS = [
  "#AF52DE", // purple
  "#FF9500", // orange
  "#34C759", // green
  "#FF3B30", // red
];

// ─── @mention dropdown ────────────────────────────────────────────────────────

function MentionDropdown({
  query,
  projectId,
  onSelect,
}: {
  query: string;
  projectId: string;
  onSelect: (user: User) => void;
  onClose: () => void;
}) {
  const [members, setMembers] = React.useState<User[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    api
      .get<Array<{ user_id: string; role: string }>>(
        `/projects/${projectId}/members`,
      )
      .then(async (memberList) => {
        if (!memberList || memberList.length === 0) {
          setMembers([]);
          return;
        }
        const userIds = memberList.map((m) => m.user_id).join(",");
        const users = await api.get<User[]>(`/users?ids=${userIds}`);
        setMembers(users);
      })
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  const filtered = members.filter(
    (u) =>
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.email.toLowerCase().includes(query.toLowerCase()),
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-3 px-4">
        <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="py-2 px-4 text-xs text-text-tertiary">
        No members found
      </div>
    );
  }

  return (
    <>
      {filtered.map((user) => (
        <button
          key={user.id}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary transition-colors"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(user);
          }}
        >
          <div className="h-6 w-6 rounded-full bg-accent flex items-center justify-center text-[10px] text-text-primary font-semibold shrink-0">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="font-medium truncate text-[13px]">{user.name}</div>
            <div className="text-[11px] text-text-tertiary truncate">
              {user.email}
            </div>
          </div>
        </button>
      ))}
    </>
  );
}

// ─── Comment input component (Frame.io style) ───────────────────────────────

export function CommentInput({
  assetId,
  projectId,
  assetType,
  replyToId,
  annotationData,
  onSubmit,
  onCancelReply,
  onPauseVideo,
  playheadTimeOverride,
  disableAnnotations,
  annotationActive,
  onToggleAnnotation,
  className,
}: CommentInputProps) {
  const {
    isDrawingMode,
    drawingTool,
    drawingColor,
    playheadTime: storePlayheadTime,
    timeFormat,
    pendingAnnotation,
    toggleDrawingMode,
    setIsDrawingMode,
    setDrawingTool,
    setDrawingColor,
    setPendingAnnotation,
    setActiveAnnotation,
  } = useReviewStore();

  const { pauseVideo } = useReview();

  const { clear, undo, getJSON } = useDrawing();

  /**
   * §228b items 3e and 3f — the composer on a phone.
   *
   * The owner, on his iPhone: "the timecode display has the correct
   * distance to the top, but the bottom needs the same distance to it. The
   * text should be centered", and the whole thing has to be thinner. He
   * also asked for the emoji button to go: the iOS keyboard has an emoji
   * key of its own, so the button spends a 44px slot on a duplicate.
   *
   * A phone, not `hover: none`: this component also renders inside §228's
   * drawer at 768px+, where a touch tablet has to stay pixel-identical.
   * `usePhoneChrome` starts `false`, so the server renders the desktop
   * composer and so does the first client render.
   *
   * §228c item 6 — and a phone on its SIDE gets the compact composer too,
   * which `useIsPhone` alone would have missed: landscape is 844px wide.
   */
  const isPhone = usePhoneChrome();
  /**
   * §232 item 3 — a phone on its SIDE only, not a phone in portrait.
   *
   * The owner's screenshot: in landscape the placeholder wraps to two
   * lines and the second is clipped — "Leave your / comment" with the
   * bottom half cut off by the field's own 36px box. The arithmetic: the
   * panel is 40% of the width with a 300px floor, which at 844px wide is
   * the floor; the composer's `px-3` takes 24 of it, the timecode chip
   * ~90 more, and §228b's no-iOS-zoom rule puts the placeholder at 16px
   * rather than 13 — at which "Leave your comment…" is wider than the
   * ~160px of field that is left, so it wraps, and the field cannot grow
   * because 36px is one line box.
   *
   * In PORTRAIT the same composer has the full 390px and the long
   * placeholder fits on one line, so it keeps it: this is about the
   * narrowest column this app puts the composer in, not about touch.
   */
  const compactLandscape = useCompactLandscape();

  // §107 — compare mode drives all three of these per-pane. Each falls back to
  // the global store when its prop is absent, which is the normal viewer, so
  // behaviour there is unchanged by construction.
  //
  // The Fabric canvas is a module-level SINGLETON: at most one pane may own
  // drawing at a time. `captureAnnotation` is what encodes that ownership —
  // an inactive pane must not read the shared canvas (it may hold the other
  // pane's in-progress drawing) and must not clear it on submit.
  const playheadTime = playheadTimeOverride ?? storePlayheadTime;
  const drawingActive = annotationActive ?? isDrawingMode;
  const captureAnnotation = annotationActive ?? !disableAnnotations;
  const toggleAnnotation = onToggleAnnotation ?? toggleDrawingMode;

  const [body, setBody] = React.useState("");
  const [mentionUserIds, setMentionUserIds] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [commentVisibility, setCommentVisibility] = React.useState<
    "public" | "internal"
  >("public");
  const [visDropdownOpen, setVisDropdownOpen] = React.useState(false);
  const [timecodeAttached, setTimecodeAttached] = React.useState(true);
  const visRef = React.useRef<HTMLDivElement>(null);

  // Emoji picker state
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const emojiRef = React.useRef<HTMLDivElement>(null);

  // Mention state
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionStart, setMentionStart] = React.useState<number>(0);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Close dropdowns on outside click
  React.useEffect(() => {
    if (!visDropdownOpen && !emojiOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        visDropdownOpen &&
        visRef.current &&
        !visRef.current.contains(e.target as Node)
      )
        setVisDropdownOpen(false);
      if (
        emojiOpen &&
        emojiRef.current &&
        !emojiRef.current.contains(e.target as Node)
      )
        setEmojiOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [visDropdownOpen, emojiOpen]);

  const canAnnotate = assetType !== "audio" && !disableAnnotations;
  const hasTimecode = assetType === "video" || assetType === "audio";

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
  const hasAnnotation =
    !!(annotationData && Object.keys(annotationData).length > 0) ||
    // Only reflect the shared pending drawing for the pane that OWNS drawing —
    // otherwise an inactive compare pane's pencil lights up while the other
    // pane is being drawn on. Always true in the normal viewer.
    (captureAnnotation &&
      !!(pendingAnnotation && (pendingAnnotation as any)?.objects?.length > 0));

  // Exit drawing mode and clear all annotation state
  function exitDrawingMode() {
    setPendingAnnotation(null);
    clear();
    toggleAnnotation();
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setBody(value);

    const cursor = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursor);
    const atIdx = textBeforeCursor.lastIndexOf("@");

    if (atIdx !== -1) {
      const afterAt = textBeforeCursor.slice(atIdx + 1);
      if (!afterAt.includes(" ") && !afterAt.includes("\n")) {
        setMentionQuery(afterAt);
        setMentionStart(atIdx);
        return;
      }
    }
    setMentionQuery(null);
  }

  function handleMentionSelect(user: User) {
    const before = body.slice(0, mentionStart);
    const after = body.slice(mentionStart + 1 + (mentionQuery?.length ?? 0));
    setBody(`${before}@${user.name} ${after}`);
    setMentionUserIds((prev) =>
      prev.includes(user.id) ? prev : [...prev, user.id],
    );
    setMentionQuery(null);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") setMentionQuery(null);
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;

    setSubmitting(true);
    setError(null);

    try {
      // Grab canvas state: try live canvas first, then store, then prop
      let finalAnnotation: Record<string, unknown> | undefined = undefined;

      // In compare, captureAnnotation is true ONLY for the active drawing
      // pane, so an inactive pane never reads the shared singleton canvas —
      // no cross-pane leak.
      if (captureAnnotation) {
        try {
          const json = getJSON();
          const objects = (json as any)?.objects;
          if (objects && Array.isArray(objects) && objects.length > 0) {
            finalAnnotation = json;
          }
        } catch {
          /* canvas may not exist */
        }
        if (drawingActive) exitDrawingMode();

        if (!finalAnnotation && pendingAnnotation) {
          const objs = (pendingAnnotation as any)?.objects;
          if (objs && Array.isArray(objs) && objs.length > 0) {
            finalAnnotation = pendingAnnotation;
          }
        }

        if (!finalAnnotation && annotationData) {
          finalAnnotation = annotationData;
        }
      }

      await onSubmit(
        trimmed,
        resolveSubmitTimecode({
          hasTimecode,
          timecodeAttached,
          hasAnnotation: !!finalAnnotation,
          playheadTime,
        }),
        undefined,
        finalAnnotation,
        replyToId ?? undefined,
        commentVisibility,
        mentionUserIds.length > 0 ? mentionUserIds : undefined,
      );

      setBody("");
      setMentionUserIds([]);
      // Touches the SHARED singleton canvas and the global store, so gate it
      // on ownership: an inactive compare pane must not clear the other
      // pane's in-progress drawing or flip isDrawingMode out from under it.
      // captureAnnotation is always true in the normal viewer.
      if (captureAnnotation) {
        setPendingAnnotation(null);
        clear(); // Clear Fabric.js canvas so stale annotations don't attach to next comment
        setIsDrawingMode(false); // Exit drawing mode after submitting annotation
        setActiveAnnotation(null); // Clear any active annotation overlay
      }
      if (replyToId && onCancelReply) onCancelReply();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post comment");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="comment-composer"
      className={cn(
        "border-t border-border bg-bg-secondary shrink-0",
        className,
      )}
    >
      {/* Reply indicator */}
      {replyToId && (
        <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-accent/10 text-xs text-accent">
          <span>Replying to comment</span>
          <button
            className="text-text-tertiary hover:text-text-primary"
            onClick={onCancelReply}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Input area */}
      <div className={cn(isPhone ? "px-3 pt-1.5 pb-1" : "px-4 pt-3 pb-2")}>
        <div className="relative">
          <div
            data-testid="comment-input-field"
            className={cn(
              "flex gap-0 rounded-lg border border-border bg-bg-tertiary focus-within:border-accent/50 focus-within:ring-1 focus-within:ring-accent/20",
              // item 3e — `items-center`, not `items-start`: with the chip
              // and the one-line textarea centred, the space above the
              // timecode chip IS the space below it, which is what the
              // owner asked for. `items-start` is what made it 9px above
              // and 17px below.
              isPhone ? "items-center" : "items-start",
            )}
          >
            {/* Inline timecode badge — show when timecode attached (normal mode) or in drawing mode */}
            {hasTimecode && (timecodeAttached || drawingActive) && (
              <span
                data-testid="comment-timecode-stamp"
                className={cn(
                  "shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] text-amber-400 leading-none select-none",
                  // No `mt` on a phone: the row centres it.
                  isPhone ? "ml-2" : "ml-2.5 mt-[9px]",
                )}
              >
                {displayTime(playheadTime)}
              </span>
            )}
            <textarea
              ref={textareaRef}
              className={cn(
                "flex-1 resize-none bg-transparent px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none max-h-[120px]",
                // item 3e — a 36px field: one 20px line box with 8px above
                // and 8px below it, so the text sits in the middle of the
                // box whatever its font-size. `leading-[20px]` and not a
                // ratio: the global 16px rule (item 2) changes the font on
                // a real phone and a ratio would move the centring with
                // it. 38px with the border, against 46px before.
                //
                // 36 and not 34: the field is a tap target too, and item
                // 3g's floor is 36. 34 was the one thing the Chromium
                // audit at 390/360/320 flagged.
                isPhone
                  ? "py-2 h-9 min-h-0 leading-[20px]"
                  : "py-2.5 min-h-[38px] hover-none:min-h-11",
              )}
              // §232 item 3 — shortened in compact landscape, and ONLY
              // there. The field keeps its 36px height and its 16px text
              // (§228b's iOS zoom rule): the text is what gives way,
              // because it is the only one of the three that can without
              // either re-introducing the zoom or growing the field into
              // a screen that has 390px of height in total.
              placeholder={
                compactLandscape
                  ? replyToId ? "Reply…" : "Comment…"
                  : replyToId ? "Write a reply..." : "Leave your comment..."
              }
              value={body}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              // §228 — on FOCUS as well as on click. The owner's flow is
              // "play to a certain point, hit comment, and the video stops
              // there and gives me that timecode": on a phone the tap that
              // focuses this field IS the click, but a Tab, a programmatic
              // focus or Safari's own focus-on-keyboard-open never fired
              // `onClick` and left the video running — which moved the
              // timecode out from under the comment being written.
              //
              // `pauseVideo` is the review provider's registered pause
              // handler (the player registers its own `pause`), and the
              // stamp below is the store's `playheadTime`, which that same
              // player writes. One timecode source, not a second one.
              onFocus={() => {
                pauseVideo();
                onPauseVideo?.();
              }}
              onClick={() => {
                pauseVideo();
                onPauseVideo?.();
              }}
              rows={1}
            />
          </div>

          {/* Mention dropdown */}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border border-border bg-bg-elevated shadow-xl max-h-48 overflow-y-auto">
              <MentionDropdown
                query={mentionQuery}
                projectId={projectId}
                onSelect={handleMentionSelect}
                onClose={() => setMentionQuery(null)}
              />
            </div>
          )}
        </div>

        {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
      </div>

      {/* Bottom toolbar */}
      <div className={cn(isPhone ? "px-3 pb-1.5" : "px-4 pb-3")}>
        {canAnnotate && drawingActive ? (
          /* ─── Drawing toolbar ─── */
          <div className="flex items-center gap-1">
            <button
              onClick={() => exitDrawingMode()}
              className="h-7 w-7 hover-none:h-11 hover-none:w-11 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
              title="Exit drawing"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <div className="w-px h-4 bg-white/10 mx-0.5" />

            {DRAW_TOOLS.map((tool) => {
              const Icon = tool.icon;
              return (
                <button
                  key={tool.id}
                  onClick={() => setDrawingTool(tool.id as DrawingTool)}
                  title={tool.label}
                  className={cn(
                    "h-7 w-7 hover-none:h-11 hover-none:w-11 flex items-center justify-center rounded-md transition-colors",
                    drawingTool === tool.id
                      ? "bg-accent/15 text-accent"
                      : "text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}

            <div className="w-px h-4 bg-white/10 mx-0.5" />

            {DRAW_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => setDrawingColor(color)}
                className={cn(
                  "w-5 h-5 hover-none:w-11 hover-none:h-11 rounded-full transition-all shrink-0",
                  drawingColor === color
                    ? "ring-2 ring-accent ring-offset-1 ring-offset-bg-secondary"
                    : "hover:scale-110",
                )}
                style={{ backgroundColor: color }}
              />
            ))}

            <div className="w-px h-4 bg-white/10 mx-0.5" />

            <button
              onClick={undo}
              className="h-7 w-7 hover-none:h-11 hover-none:w-11 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
              title="Undo"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={clear}
              className="h-7 w-7 hover-none:h-11 hover-none:w-11 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
              title="Clear"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          /* ─── Default toolbar (Frame.io style) ─── */
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {/* Timecode attach toggle — for video/audio */}
              {hasTimecode && (
                <button
                  data-testid="comment-timecode-toggle"
                  aria-pressed={timecodeAttached}
                  aria-label={
                    timecodeAttached ? "Detach timecode" : "Attach timecode"
                  }
                  className={cn(
                    // §228 — `hover-none:h-11 hover-none:w-11`: this is how
                    // the stamp is REMOVED, so on a phone it has to be
                    // hittable. Same media-feature variant header.tsx
                    // already uses; a mouse sees the 28px button unchanged.
                    // §228b item 3g — on a PHONE that drops to the 36px
                    // floor: this is a secondary control, and the 8px it
                    // gives back is 8px of comment list.
                    "flex items-center justify-center rounded-md transition-colors",
                    isPhone
                      ? "h-9 w-9"
                      : "h-7 w-7 hover-none:h-11 hover-none:w-11",
                    timecodeAttached
                      ? "text-amber-400 bg-amber-400/10"
                      : "text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary",
                  )}
                  onClick={() => setTimecodeAttached((p) => !p)}
                  title={
                    timecodeAttached ? "Detach timecode" : "Attach timecode"
                  }
                >
                  <Clock className="h-4 w-4" />
                </button>
              )}

              {/* Draw annotation — hidden for audio */}
              {canAnnotate && (
                <button
                  className={cn(
                    "flex items-center justify-center rounded-md transition-colors",
                    isPhone
                      ? "h-9 w-9"
                      : "h-7 w-7 hover-none:h-11 hover-none:w-11",
                    hasAnnotation
                      ? "text-accent bg-accent/10"
                      : "text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary",
                  )}
                  onClick={() => toggleAnnotation()}
                  title="Draw annotation"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}

              {/* Emoji.
                  §228b item 3f — not on a phone. "Remove the emoji button
                  in mobile view" — the iOS keyboard has its own emoji key,
                  so this button spends a 44px slot of a 390px row on a
                  duplicate of something the keyboard already offers. Not
                  rendered at all rather than hidden with CSS, so there is
                  no invisible target left behind it. Desktop keeps it. */}
              {!isPhone && (
              <div className="relative" ref={emojiRef}>
                <button
                  data-testid="comment-emoji-button"
                  className="h-7 w-7 hover-none:h-11 hover-none:w-11 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
                  title="Add emoji"
                  onClick={() => setEmojiOpen((p) => !p)}
                >
                  <Smile className="h-4 w-4" />
                </button>
                {emojiOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 rounded-lg border border-border bg-bg-elevated shadow-2xl p-1.5 animate-in fade-in zoom-in-95 duration-100 w-[200px]">
                    <div className="grid grid-cols-8 gap-px">
                      {EMOJIS.map((e) => (
                        <button
                          key={e}
                          className="h-6 w-6 hover-none:h-11 hover-none:w-11 rounded flex items-center justify-center text-sm hover:bg-bg-hover transition-colors"
                          onClick={() => {
                            setBody((prev) => prev + e);
                            setEmojiOpen(false);
                            textareaRef.current?.focus();
                          }}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Visibility dropdown */}
              <div className="relative" ref={visRef}>
                <button
                  onClick={() => setVisDropdownOpen((p) => !p)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 rounded-md text-[12px] transition-colors border",
                    // item 3g — the 36px floor on a phone; 44 elsewhere on
                    // touch, 28 on a mouse.
                    isPhone ? "h-9" : "h-7 hover-none:h-11",
                    commentVisibility === "internal"
                      ? "text-amber-400 border-amber-400/30 bg-amber-400/10"
                      : "text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary border-border",
                  )}
                >
                  {commentVisibility === "internal" ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Globe className="h-3 w-3" />
                  )}
                  {commentVisibility === "internal" ? "Internal" : "Public"}
                  <ChevronDown className="h-3 w-3" />
                </button>
                {visDropdownOpen && (
                  <div className="absolute bottom-full right-0 mb-1 z-50 w-44 rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100">
                    <button
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-2 text-[13px] transition-colors",
                        commentVisibility === "public"
                          ? "text-text-primary bg-bg-tertiary"
                          : "text-text-secondary hover:bg-bg-tertiary",
                      )}
                      onClick={() => {
                        setCommentVisibility("public");
                        setVisDropdownOpen(false);
                      }}
                    >
                      <Globe className="h-3.5 w-3.5" />
                      Public
                    </button>
                    <button
                      className={cn(
                        "flex w-full items-center gap-2.5 px-3 py-2 text-[13px] transition-colors",
                        commentVisibility === "internal"
                          ? "text-amber-400 bg-bg-tertiary"
                          : "text-text-secondary hover:bg-bg-tertiary",
                      )}
                      onClick={() => {
                        setCommentVisibility("internal");
                        setVisDropdownOpen(false);
                      }}
                    >
                      <Lock className="h-3.5 w-3.5" />
                      Internal
                    </button>
                  </div>
                )}
              </div>

              {/* Submit */}
              <button
                onClick={handleSubmit}
                disabled={!body.trim() || submitting}
                data-testid="comment-submit"
                // item 3g — Send is on the PRIMARY list: 44x44 on a phone,
                // unchanged. It is also what sets the action row's height,
                // which is why that row is 44px and not 36px.
                className={cn(
                  "inline-flex items-center justify-center rounded-full bg-accent text-text-primary hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors",
                  isPhone ? "h-11 w-11" : "h-7 w-7 hover-none:h-11 hover-none:w-11",
                )}
                title="Send (Enter)"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
