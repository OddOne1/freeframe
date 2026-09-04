"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";
import { resolveApiMediaUrl } from "@/lib/utils";
import { useReviewStore } from "@/stores/review-store";
import type { AssetResponse, AssetVersion, Comment } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateCommentPayload {
  body: string;
  version_id?: string;
  parent_id?: string;
  timecode_start?: number;
  timecode_end?: number;
  annotation?: { drawing_data: Record<string, unknown> };
}

interface ReviewContextValue {
  assetId: string;
  asset: AssetResponse | null;
  shareToken?: string;
  shareSession?: string | null;
  versions: AssetVersion[];
  comments: Comment[];
  isLoading: boolean;
  error: string | null;
  addComment: (payload: CreateCommentPayload) => Promise<Comment>;
  resolveComment: (commentId: string) => Promise<void>;
  seekTo: (time: number) => void;
  refetchComments: () => Promise<void>;
  refetchVersions: () => Promise<void>;
  pauseVideo: () => void;
  registerPauseHandler: (handler: () => void) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ReviewContext = createContext<ReviewContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface ReviewProviderProps {
  assetId: string;
  shareToken?: string; // If set, uses share token API instead of authenticated API
  shareSession?: string | null;
  children: React.ReactNode;
}

export function ReviewProvider({
  assetId,
  shareToken,
  shareSession,
  children,
}: ReviewProviderProps) {
  const [asset, setAsset] = useState<AssetResponse | null>(null);
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pauseHandlerRef = useRef<(() => void) | null>(null);

  const { setCurrentAsset, setCurrentVersion, setPlayheadTime } =
    useReviewStore();

  // Track whether component is still mounted to avoid state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const shareSessionParam = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : '';

  /**
   * The store's setters, reached through refs rather than depended upon.
   *
   * Their IDENTITY was a dependency of both fetchAsset and the effect below.
   * Under the real zustand store those identities never change, so this was
   * invisible — but for any caller whose store hook returns fresh functions
   * per render, every render rebuilt fetchAsset, which re-ran the effect that
   * calls it, which set state, which rendered again. An unbounded loop:
   * measured at ~8,000 renders in 250ms.
   *
   * It was already latent before §121 and is why adding one more state write
   * here hung a whole test worker — and vitest reports a hung worker as
   * SKIPPED with exit code 0, so six tests silently stopped running while the
   * suite still looked green. Same ref pattern CollapsibleSection already
   * uses for its onChange.
   */
  /**
   * §122 — which asset is on screen RIGHT NOW, for comparison against the
   * asset a given in-flight request was made for.
   *
   * The blank slate from §121 stops a NEW asset being paired with an OLD
   * version, but it cannot stop an OLD request landing late: open A, open B
   * before A answers, and A's response then writes A's version into a page
   * showing B — recreating the same mismatch from the other direction.
   * Responses are not ordered, so every write below is gated on the asset
   * still being the one that was asked for.
   */
  const assetIdRef = useRef(assetId);
  assetIdRef.current = assetId;

  const setCurrentAssetRef = useRef(setCurrentAsset);
  setCurrentAssetRef.current = setCurrentAsset;
  const setCurrentVersionRef = useRef(setCurrentVersion);
  setCurrentVersionRef.current = setCurrentVersion;

  const fetchAsset = useCallback(async () => {
    try {
      let data: AssetResponse;

      if (shareToken) {
        // Share mode: fetch stream info to build a pseudo asset
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const headers: Record<string, string> = {};
        try {
          const t = localStorage.getItem("ff_access_token");
          if (t) headers["Authorization"] = `Bearer ${t}`;
        } catch {}
        const streamRes = await fetch(
          `${API_URL}/share/${shareToken}/stream/${assetId}?_=1${shareSessionParam}`,
          { headers },
        );
        const streamData = streamRes.ok ? await streamRes.json() : null;
        // Build pseudo asset from available data
        data = {
          id: assetId,
          name: streamData?.name || "Asset",
          description: null,
          asset_type: streamData?.asset_type || "image",
          status: "in_review",
          rating: null,
          assignee_id: null,
          folder_id: null,
          due_date: null,
          keywords: [],
          project_id: "",
          created_by: "",
          created_at: "",
          updated_at: "",
          deleted_at: null,
          // RAW, not resolved (CLAUDE.md §32). VideoPlayer prepends
          // NEXT_PUBLIC_API_URL itself to any stream url starting with "/"
          // (video-player.tsx:213-217), so resolving here as well produced
          // `/api/api/stream/hls/master.m3u8` and 404'd every video in a
          // folder share. The authenticated branch below already leaves
          // stream_url alone — that asymmetry, feeding one shared consumer,
          // is what made this reachable from share links only.
          stream_url: streamData?.url ?? undefined,
          thumbnail_url: resolveApiMediaUrl(streamData?.thumbnail_url),
          latest_version: streamData?.version_id
            ? {
                id: streamData.version_id,
                asset_id: assetId,
                version_number: 1,
                processing_status: "ready",
                created_by: "",
                created_at: "",
                deleted_at: null,
                files: [],
              }
            : null,
        } as AssetResponse;
      } else {
        // Normal mode: authenticated API
        data = await api.get<AssetResponse>(`/assets/${assetId}`);
        data = { ...data, thumbnail_url: resolveApiMediaUrl(data.thumbnail_url) };
      }

      if (!mountedRef.current || assetIdRef.current !== assetId) return;
      setAsset(data);
      setCurrentAssetRef.current(data);

      if (!shareToken) {
        // Fetch all versions for the version switcher (not available in share mode)
        const allVersions = await api.get<AssetVersion[]>(
          `/assets/${assetId}/versions`,
        );
        if (!mountedRef.current || assetIdRef.current !== assetId) return;
        setVersions(allVersions ?? []);

        const readyVersion = (allVersions ?? [])
          .sort((a, b) => b.version_number - a.version_number)
          .find((v) => v.processing_status === "ready");
        if (readyVersion) {
          setCurrentVersionRef.current(readyVersion);
        } else if (data.latest_version) {
          setCurrentVersionRef.current(data.latest_version);
        }
      } else if (data.latest_version) {
        setCurrentVersionRef.current(data.latest_version);
      }
    } catch (err) {
      if (!mountedRef.current || assetIdRef.current !== assetId) return;
      setError(err instanceof Error ? err.message : "Failed to load asset");
    }
  }, [assetId, shareToken, shareSessionParam]);

  const fetchComments = useCallback(async () => {
    try {
      let data: Comment[];
      if (shareToken) {
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const res = await fetch(
          `${API_URL}/share/${shareToken}/comments?asset_id=${assetId}${shareSessionParam}`,
        );
        if (res.ok) {
          const json = await res.json();
          // Handle both formats: array directly or {comments: [...]}
          data = Array.isArray(json) ? json : (json.comments ?? []);
        } else {
          data = [];
        }
      } else {
        data = await api.get<Comment[]>(`/assets/${assetId}/comments`);
      }
      if (!mountedRef.current || assetIdRef.current !== assetId) return;
      setComments(data ?? []);
    } catch {
      // Comments failing silently — asset is still viewable
    }
  }, [assetId, shareToken]);

  const refetchComments = useCallback(async () => {
    await fetchComments();
  }, [fetchComments]);

  const refetchVersions = useCallback(async () => {
    if (shareToken) return;
    try {
      const allVersions = await api.get<AssetVersion[]>(`/assets/${assetId}/versions`);
      if (!mountedRef.current) return;
      setVersions(allVersions ?? []);
    } catch {
      // ignore
    }
  }, [assetId, shareToken]);

  /**
   * §121 — drop the previous asset's version BEFORE loading the next one.
   *
   * currentVersion lives in a global store, and fetchAsset sets the new asset
   * a full network round trip before it sets the new version (it has to fetch
   * /assets/{id}/versions in between). For the whole of that window the app
   * held the NEW asset paired with the OLD asset's version — and every
   * consumer builds a request out of exactly that pair:
   *
   *   /assets/{new}/transcript?version_id={old}   -> 404 No version found
   *   /assets/{new}/stream?version_id={old}       -> 404
   *   /assets/{new}/comments?version_id={old}
   *   /assets/{new}/approvals?version_id={old}
   *
   * which is where the reported transcript 404 came from: an asset id and a
   * version id belonging to two different assets. Clearing here means the
   * key is simply null until the real version arrives, so the bogus request
   * is never made rather than being made and handled.
   *
   * Declared before the fetch effect so it runs first on an assetId change.
   * isLoading is true across that whole window, so consumers that
   * distinguish "still resolving" from "nothing to play" stay correct.
   */

  useEffect(() => {
    // Guarded so a fresh [] is not written on every mount: an unconditional
    // new array reference is its own re-render, which is the other half of
    // the loop above.
    setVersions((prev) => (prev.length ? [] : prev));
    setCurrentVersionRef.current(null);
  }, [assetId]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    Promise.all([fetchAsset(), fetchComments()]).finally(() => {
      if (mountedRef.current) setIsLoading(false);
    });
  }, [fetchAsset, fetchComments]);

  const addComment = useCallback(
    async (payload: CreateCommentPayload): Promise<Comment> => {
      let comment: Comment;
      if (shareToken) {
        const API_URL =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        try {
          const t = localStorage.getItem("ff_access_token");
          if (t) headers["Authorization"] = `Bearer ${t}`;
        } catch {}
        // Include guest identity if available (for non-authenticated users)
        const guestFields: Record<string, string> = {};
        try {
          const stored = localStorage.getItem("ff_guest_identity");
          if (stored) {
            const guest = JSON.parse(stored);
            guestFields.guest_name = guest.name;
            guestFields.guest_email = guest.email;
          }
        } catch {}
        const res = await fetch(`${API_URL}/share/${shareToken}/comment?_=1${shareSessionParam}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, ...guestFields, asset_id: assetId }),
        });
        if (!res.ok) throw new Error("Failed to post comment");
        comment = await res.json();
      } else {
        comment = await api.post<Comment>(
          `/assets/${assetId}/comments`,
          payload,
        );
      }
      if (mountedRef.current) {
        setComments((prev) => [...prev, comment]);
      }
      return comment;
    },
    [assetId],
  );

  const resolveComment = useCallback(
    async (commentId: string): Promise<void> => {
      await api.post(`/comments/${commentId}/resolve`);
      if (mountedRef.current) {
        setComments((prev) =>
          prev.map((c) => (c.id === commentId ? { ...c, resolved: true } : c)),
        );
      }
    },
    [],
  );

  const seekTo = useCallback(
    (time: number) => {
      setPlayheadTime(time);
    },
    [setPlayheadTime],
  );

  const pauseVideo = useCallback(() => {
    if (pauseHandlerRef.current) {
      pauseHandlerRef.current();
    }
  }, []);

  const registerPauseHandler = useCallback((handler: () => void) => {
    pauseHandlerRef.current = handler;
  }, []);

  const value = useMemo<ReviewContextValue>(
    () => ({
      assetId,
      asset,
      shareToken,
      shareSession,
      versions,
      comments,
      isLoading,
      error,
      addComment,
      resolveComment,
      seekTo,
      refetchComments,
      refetchVersions,
      pauseVideo,
      registerPauseHandler,
    }),
    [
      assetId,
      asset,
      versions,
      comments,
      isLoading,
      error,
      addComment,
      resolveComment,
      seekTo,
      refetchComments,
      refetchVersions,
      pauseVideo,
      registerPauseHandler,
    ],
  );

  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext);
  if (!ctx) {
    throw new Error("useReview must be used inside <ReviewProvider>");
  }
  return ctx;
}
