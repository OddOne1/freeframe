"use client";

/**
 * SocialSnippet: search a project's transcripts for short clips, review
 * them, trim them and export them.
 *
 * Built on socialsnippet-api-contract.md (draft v1) as amended by the finished
 * backend: moments carry null title/source/status/generator; `status` is a
 * repeatable filter (default hides rejected, and naming any status drops
 * moments); group=topic repeats a clip under each topic, so `total` counts
 * entries and a group may continue on the next page.
 */
import * as React from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import { flushSync } from "react-dom";
import { ChevronDown, Files, Keyboard, Scissors, SearchX, Settings2, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  errorMessage,
  errorStatus,
  fixturesEnabled,
  snippetApi,
  snippetFetcher,
  snippetKeys,
} from "@/lib/snippet-api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/skeleton";
import { useOptionalToast } from "@/components/shared/toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbStore } from "@/stores/breadcrumb-store";
import {
  SHORTCUTS,
  cardKeyOf,
  createPlayerGroup,
  describeChange,
  isEmptyPatch,
  shortcutFor,
  targetKind,
} from "@/lib/snippet-card";
import { ClipCard, type ClipCardController } from "@/components/snippets/clip-card";
import { SnippetFilesTab } from "@/components/snippets/snippet-files-tab";
import { SnippetSearchBox } from "@/components/snippets/snippet-search-box";
import { SnippetSettingsDialog } from "@/components/snippets/snippet-settings-dialog";
import { useSnippetAccess } from "@/components/snippets/use-snippet-access";
import {
  Chip,
  FilterChip,
  SnippetSelect,
  type SelectOption,
} from "@/components/snippets/snippet-ui";
import type {
  Project,
  SnippetClip,
  SnippetClipGroup,
  SnippetGroup,
  SnippetPatch,
  SnippetSearchParams,
  SnippetSearchResponse,
  SnippetSort,
  SnippetSource,
  SnippetSpeaker,
  SnippetStatus,
  SnippetSuggest,
} from "@/types";

const PAGE_SIZE = 24;

const SORTS: SelectOption<SnippetSort>[] = [
  { value: "relevance", label: "Relevance" },
  { value: "quality", label: "Quality" },
  { value: "viral", label: "Viral" },
  { value: "length_asc", label: "Shortest" },
  { value: "length_desc", label: "Longest" },
];

const GROUPS: SelectOption<SnippetGroup>[] = [
  { value: "none", label: "None" },
  { value: "speaker", label: "Speaker" },
  { value: "topic", label: "Topic" },
];

type LengthKey = "any" | "short" | "medium" | "long" | "xlong";
const LENGTHS: (SelectOption<LengthKey> & { min: number | null; max: number | null })[] = [
  { value: "any", label: "Any length", min: null, max: null },
  { value: "short", label: "Under 15 s", min: null, max: 15_000 },
  { value: "medium", label: "15–30 s", min: 15_000, max: 30_000 },
  { value: "long", label: "30–60 s", min: 30_000, max: 60_000 },
  { value: "xlong", label: "Over 60 s", min: 60_000, max: null },
];

/** The three source words the cards show, and the contract sources each covers. */
const SOURCE_FILTERS: { label: string; sources: SnippetSource[] }[] = [
  { label: "Auto", sources: ["keyword", "llm"] },
  { label: "Imported", sources: ["import"] },
  { label: "Manual", sources: ["manual"] },
];

type StatusKey = "default" | SnippetStatus | "all";
const STATUSES: SelectOption<StatusKey>[] = [
  { value: "default", label: "Not rejected" },
  { value: "suggested", label: "Suggested" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All clips" },
];
const statusParam = (k: StatusKey): SnippetStatus[] =>
  k === "default" ? [] : k === "all" ? ["suggested", "approved", "rejected"] : [k];

/** Pages glued together: a group that continues onto the next page is one group. */
function mergePages(pages: SnippetSearchResponse[] | undefined): SnippetClipGroup[] {
  const out: SnippetClipGroup[] = [];
  for (const page of pages ?? []) {
    for (const g of page.groups) {
      const last = out[out.length - 1];
      if (last && last.key === g.key) last.items = [...last.items, ...g.items];
      else out.push({ ...g, items: [...g.items] });
    }
  }
  return out;
}

/** Topic picker options: the most used topics plus any already applied,
 *  each spelling once (topics are matched case-insensitively). */
function topicOptions(popular: string[], applied: string[]) {
  const byKey: Record<string, string> = {};
  for (const t of [...popular, ...applied]) byKey[t.toLowerCase()] ??= t;
  return Object.values(byKey).map((t) => ({
    key: t,
    label: `#${t}`,
    on: applied.some((a) => a.toLowerCase() === t.toLowerCase()),
  }));
}

const NO_SPEAKERS: SnippetSpeaker[] = [];

/** "3 clips · 2 files" under a group heading. */
function groupSummary(items: SnippetClip[]): string {
  const files = new Set(items.map((c) => c.media_file_id)).size;
  return `${items.length} ${items.length === 1 ? "clip" : "clips"} · ${files} ${files === 1 ? "file" : "files"}`;
}

/** The last saved change, for the Undo toast. */
interface UndoEntry {
  id: number;
  clipId: string;
  cardKey: string;
  inverse: SnippetPatch;
  message: string;
}

const UNDO_TOAST_MS = 7000;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Opening or closing a card reflows the grid; this slides every card from
 * where it was to where it lands (FLIP: measure, change, measure, animate
 * the difference), so the eye can follow the cards that moved.
 */
function flipCards(update: () => void) {
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-clip-key]"));
  const before = new Map(cards.map((el) => [el, el.getBoundingClientRect()]));
  flushSync(update);
  if (prefersReducedMotion()) return;
  for (const el of cards) {
    const a = before.get(el);
    if (!a || !el.isConnected || typeof el.animate !== "function") continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
      duration: 260,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  }
}

export default function SnippetsPage() {
  const params = useParams();
  const projectId = params.id as string;
  const pathname = usePathname();
  const toast = useOptionalToast();

  const { data: project } = useSWR<Project>(`/projects/${projectId}`, () =>
    api.get<Project>(`/projects/${projectId}`),
  );
  const { canEdit, canManage, settings, settingsError, settingsLoading, mutateSettings } =
    useSnippetAccess(projectId);

  usePageTitle(project ? `SocialSnippet · ${project.name}` : "SocialSnippet");
  const setLabel = useBreadcrumbStore((s) => s.setLabel);
  React.useEffect(() => {
    if (project?.name) setLabel(pathname, projectId, project.name);
    setLabel(pathname, "snippets", "SocialSnippet");
  }, [project?.name, projectId, pathname, setLabel]);
  React.useEffect(() => () => useBreadcrumbStore.getState().clear(pathname), [pathname]);

  // ── Query state ─────────────────────────────────────────────────────────
  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");
  const [speakers, setSpeakers] = React.useState<SnippetSpeaker[]>([]);
  const [topics, setTopics] = React.useState<string[]>([]);
  const [length, setLength] = React.useState<LengthKey>("any");
  const [sourceLabels, setSourceLabels] = React.useState<string[]>([]);
  const [status, setStatus] = React.useState<StatusKey>("default");
  const [sort, setSort] = React.useState<SnippetSort>("relevance");
  const [group, setGroup] = React.useState<SnippetGroup>("none");

  // Typing searches after a pause; Enter searches at once.
  React.useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 400);
    return () => clearTimeout(t);
  }, [text]);

  const len = LENGTHS.find((l) => l.value === length)!;
  const query: SnippetSearchParams = {
    q,
    speaker_id: speakers.map((s) => s.id),
    topic: topics,
    min_ms: len.min,
    max_ms: len.max,
    source: SOURCE_FILTERS.filter((f) => sourceLabels.includes(f.label)).flatMap((f) => f.sources),
    status: statusParam(status),
    sort,
    group,
    page_size: PAGE_SIZE,
  };

  const enabled = settings?.enabled === true && !settingsError;
  const search = useSWRInfinite<SnippetSearchResponse>(
    (index, prev: SnippetSearchResponse | null) => {
      if (!enabled) return null;
      if (prev && index * PAGE_SIZE >= prev.total) return null;
      return snippetKeys.search(projectId, { ...query, page: index + 1 });
    },
    snippetFetcher,
    { revalidateFirstPage: false, shouldRetryOnError: false },
  );
  const groups = mergePages(search.data);
  const total = search.data?.[0]?.total ?? 0;
  const loaded = groups.reduce((n, g) => n + g.items.length, 0);
  const loadingFirst = enabled && !search.data && !search.error;
  const loadingMore = search.isValidating && search.size > (search.data?.length ?? 0);

  // ── Filter data ─────────────────────────────────────────────────────────
  const { data: allSpeakers } = useSWR<SnippetSpeaker[]>(
    enabled ? snippetKeys.speakers(projectId) : null,
    snippetFetcher,
  );
  const { data: popular } = useSWR<SnippetSuggest>(
    enabled ? snippetKeys.suggest(projectId, "") : null,
    snippetFetcher,
  );

  const addSpeaker = (s: SnippetSpeaker) =>
    setSpeakers((cur) => (cur.some((c) => c.id === s.id) ? cur : [...cur, s]));
  const hasTopic = (t: string) => topics.some((c) => c.toLowerCase() === t.toLowerCase());
  const toggleTopic = (t: string) =>
    setTopics((cur) =>
      cur.some((c) => c.toLowerCase() === t.toLowerCase())
        ? cur.filter((c) => c.toLowerCase() !== t.toLowerCase())
        : [...cur, t],
    );
  const hasFilters =
    !!q ||
    speakers.length > 0 ||
    topics.length > 0 ||
    length !== "any" ||
    sourceLabels.length > 0 ||
    status !== "default";
  function clearAll() {
    setText("");
    setQ("");
    setSpeakers([]);
    setTopics([]);
    setLength("any");
    setSourceLabels([]);
    setStatus("default");
  }

  // ── Player and review ───────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  // Clips for everyone; Files (which files are processed, speakers per
  // track) for editors and owners only, as GET /snippet/files is.
  // The open tab is in the URL (?tab=files), as the Files tab's own view is,
  // so a reload or a shared link comes back to it. history.replaceState, which
  // Next (14.1+) feeds back into useSearchParams, rather than a router
  // navigation that would reset the page title to the layout's.
  const searchParams = useSearchParams();
  const tab: "clips" | "files" = searchParams.get("tab") === "files" ? "files" : "clips";
  const setTab = (next: "clips" | "files") => {
    const qs = new URLSearchParams(searchParams.toString());
    if (next === "files") qs.set("tab", "files");
    else qs.delete("tab");
    const s = qs.toString();
    // `null`, not history.state: Next's own marker there makes it skip the update.
    window.history.replaceState(null, "", s ? `${pathname}?${s}` : pathname);
  };

  // One player for the whole grid (see createPlayerGroup) and one open card.
  const [players] = React.useState(createPlayerGroup);
  const activeKey = React.useSyncExternalStore(players.subscribe, players.active, () => null);
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const toggleExpand = React.useCallback((key: string) => {
    flipCards(() => setExpandedKey((cur) => (cur === key ? null : key)));
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-clip-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" }),
    );
  }, []);

  // Cards register what the keyboard and Undo drive.
  const controllers = React.useRef(new Map<string, ClipCardController>());
  const register = React.useCallback((key: string, c: ClipCardController) => {
    controllers.current.set(key, c);
    return () => {
      if (controllers.current.get(key) === c) controllers.current.delete(key);
    };
  }, []);

  // ── Saves and Undo ──────────────────────────────────────────────────────
  const [undo, setUndo] = React.useState<UndoEntry | null>(null);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  const searchRef = React.useRef(search);
  searchRef.current = search;

  /** The server's copy of a clip, put in place without reloading the list,
   *  so a card being trimmed does not jump under a sort. */
  const replaceClip = React.useCallback((updated: SnippetClip) => {
    void searchRef.current.mutate(
      (pages) =>
        pages?.map((p) => ({
          ...p,
          groups: p.groups.map((g) => ({
            ...g,
            items: g.items.map((c) => (c.id === updated.id ? updated : c)),
          })),
        })),
      { revalidate: false },
    );
  }, []);

  const onSaved = React.useCallback(
    (updated: SnippetClip, sent: SnippetPatch, inverse: SnippetPatch, cardKey: string) => {
      // A status change can move the clip in or out of this view, as before.
      if ("status" in sent) void searchRef.current.mutate();
      else replaceClip(updated);
      if (isEmptyPatch(inverse)) {
        setUndo(null);
        return;
      }
      const hidden = sent.status === "rejected" && statusRef.current === "default";
      setUndo({
        id: Date.now(),
        clipId: updated.id,
        cardKey,
        inverse,
        message: hidden ? "Rejected. Rejected clips are hidden in this view." : describeChange(sent),
      });
    },
    [replaceClip],
  );

  async function runUndo(entry: UndoEntry) {
    setUndo(null);
    const card = controllers.current.get(entry.cardKey);
    if (card && card.clipId === entry.clipId) {
      card.undo(entry.inverse);
      return;
    }
    // The card is gone (a rejected clip left this view): undo directly.
    try {
      await snippetApi.patchSnippet(entry.clipId, entry.inverse);
      await search.mutate();
    } catch (err) {
      toast(errorMessage(err, "Could not undo the change."), "error");
    }
  }

  const onTracksChanged = React.useCallback(() => void searchRef.current.mutate(), []);

  // Nothing typed is lost to a closed tab while a save is waiting.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Array.from(controllers.current.values()).some((c) => c.busy())) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ── Keyboard ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (tab !== "clips") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = shortcutFor(e, targetKind(e.target));
      if (!action) return;
      const focused =
        (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-clip-key]")?.dataset.clipKey ??
        null;
      const active = players.active();
      const key = action.type === "toggle-expand" ? (focused ?? active) : (active ?? focused);
      const card = key ? controllers.current.get(key) : undefined;
      if (card?.run(action)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tab, players]);

  // ── Render ──────────────────────────────────────────────────────────────
  // The trail (Projects › project › SocialSnippet) is the Header's, fed by
  // the breadcrumb store above; repeating it here showed it twice.
  const header = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-text-primary">SocialSnippet</h1>
          <p className="mt-0.5 text-sm text-text-secondary">
            Short clips from this project&apos;s transcripts.
            {fixturesEnabled && (
              <span className="ml-2 rounded bg-status-warning/15 px-1.5 py-0.5 text-2xs font-medium text-status-warning">
                Dev fixtures
              </span>
            )}
          </p>
        </div>
        {canManage && settings && (
          <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)} aria-label="SocialSnippet settings">
            <Settings2 className="h-4 w-4" />
            <span className="hidden sm:inline">Settings</span>
          </Button>
        )}
      </div>
    </>
  );

  const settingsDialog = canManage ? (
    <SnippetSettingsDialog
      projectId={projectId}
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      settings={settings}
      onSaved={(s) => void mutateSettings(s, { revalidate: false })}
    />
  ) : null;

  const shell = (children: React.ReactNode) => (
    <div className="space-y-5 px-4 py-6 sm:p-6">
      {header}
      {children}
      {settingsDialog}
    </div>
  );

  // Not a member / no such project, or the feature is off.
  if (settingsLoading) return shell(<ResultsSkeleton />);
  if (errorStatus(settingsError) === 404) {
    return shell(
      <EmptyState
        icon={SearchX}
        title="Project not found"
        description="It does not exist, or you are not a member of it."
      />,
    );
  }
  if (settingsError && errorStatus(settingsError) !== 409) {
    return shell(
      <EmptyState
        icon={SearchX}
        title="Could not load SocialSnippet"
        description={errorMessage(settingsError)}
        action={{ label: "Retry", onClick: () => void mutateSettings() }}
      />,
    );
  }
  if (!enabled) {
    return shell(
      <EmptyState
        icon={Scissors}
        title="SocialSnippet is off for this project"
        description={canManage ? "Turn it on to search transcripts for clips." : "Ask the project owner to turn it on."}
        action={canManage ? { label: "Set up SocialSnippet", onClick: () => setSettingsOpen(true) } : undefined}
      />,
    );
  }

  const searchStatus = errorStatus(search.error);

  const clipsView = (
    <>
      {/* Search and filters */}
      <div className="space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="lg:max-w-xl lg:flex-1">
            <SnippetSearchBox
              projectId={projectId}
              value={text}
              onChange={setText}
              onSubmit={(v) => setQ(v.trim())}
              onPickSpeaker={addSpeaker}
              onPickTopic={(t) => {
                if (!hasTopic(t)) toggleTopic(t);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SnippetSelect label="Sort" value={sort} onChange={setSort} options={SORTS} />
            <SnippetSelect label="Group" value={group} onChange={setGroup} options={GROUPS} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <PickerPopover
            label="Speaker"
            count={speakers.length}
            empty="No speakers yet."
            options={(allSpeakers ?? []).map((s) => ({
              key: s.id,
              label: s.name,
              on: speakers.some((c) => c.id === s.id),
            }))}
            onToggle={(key) => {
              const s = allSpeakers?.find((x) => x.id === key);
              if (!s) return;
              setSpeakers((cur) =>
                cur.some((c) => c.id === key) ? cur.filter((c) => c.id !== key) : [...cur, s],
              );
            }}
          />
          <PickerPopover
            label="Topic"
            count={topics.length}
            empty="No topics yet."
            options={topicOptions((popular?.topics ?? []).map((t) => t.topic), topics)}
            onToggle={toggleTopic}
          />
          <SnippetSelect label="Length" value={length} onChange={setLength} options={LENGTHS} />
          <SnippetSelect label="Status" value={status} onChange={setStatus} options={STATUSES} />
          <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" aria-hidden />
          {SOURCE_FILTERS.map((f) => (
            <Chip
              key={f.label}
              active={sourceLabels.includes(f.label)}
              onClick={() =>
                setSourceLabels((cur) =>
                  cur.includes(f.label) ? cur.filter((x) => x !== f.label) : [...cur, f.label],
                )
              }
              title={`Source: ${f.sources.join(", ")}`}
            >
              {f.label}
            </Chip>
          ))}
        </div>

        {(speakers.length > 0 || topics.length > 0 || q) && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {q && (
              <FilterChip
                label={`“${q}”`}
                onRemove={() => {
                  setText("");
                  setQ("");
                }}
              />
            )}
            {speakers.map((s) => (
              <FilterChip
                key={s.id}
                label={s.name}
                onRemove={() => setSpeakers((cur) => cur.filter((c) => c.id !== s.id))}
              />
            ))}
            {topics.map((t) => (
              <FilterChip key={t} label={`#${t}`} onRemove={() => toggleTopic(t)} />
            ))}
            <button
              type="button"
              onClick={clearAll}
              className="ml-1 rounded text-xs text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* Results */}
      <div aria-live="polite" className="sr-only">
        {search.data ? `${total} ${total === 1 ? "result" : "results"}` : ""}
      </div>
      {loadingFirst ? (
        <ResultsSkeleton />
      ) : search.error && !search.data ? (
        <EmptyState
          icon={SearchX}
          title={searchStatus === 422 ? "That filter does not work" : "Search failed"}
          description={errorMessage(search.error)}
          action={{ label: "Retry", onClick: () => void search.mutate() }}
        />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={hasFilters ? "No clips match" : "No clips yet"}
          description={
            hasFilters
              ? "Try fewer filters or another word."
              : "Clips appear here once this project's assets are transcribed."
          }
          action={hasFilters ? { label: "Clear filters", onClick: clearAll } : undefined}
        />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-text-tertiary">
              {total}{" "}
              {group === "topic" ? (total === 1 ? "entry" : "entries") : total === 1 ? "result" : "results"}
              {group === "topic" && " (a clip appears under each of its topics)"}
            </p>
            <ShortcutsHelp />
          </div>
          {groups.map((g) => (
            <section key={g.key} aria-label={group === "none" ? "Results" : g.label}>
              {group !== "none" && (
                <h2 className="mb-3 flex flex-wrap items-baseline gap-x-2 text-base font-semibold text-text-primary">
                  {g.label}
                  <span className="text-xs font-normal tabular-nums text-text-tertiary">{groupSummary(g.items)}</span>
                </h2>
              )}
              {/* Dense flow: the opened card spans the row and the others fill in around it. */}
              <div className="grid grid-flow-row-dense grid-cols-1 gap-4 lg:grid-cols-2">
                {g.items.map((clip) => {
                  const key = cardKeyOf(g.key, clip.id);
                  return (
                    <ClipCard
                      key={key}
                      cardKey={key}
                      clip={clip}
                      projectId={projectId}
                      canEdit={canEdit}
                      speakers={allSpeakers ?? NO_SPEAKERS}
                      activeTopics={topics}
                      active={activeKey === key}
                      expanded={expandedKey === key}
                      group={players}
                      onTopic={toggleTopic}
                      onToggleExpand={toggleExpand}
                      onSaved={onSaved}
                      onTracksChanged={onTracksChanged}
                      register={register}
                    />
                  );
                })}
              </div>
            </section>
          ))}
          {loaded < total && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={loadingMore}
                onClick={() => void search.setSize(search.size + 1)}
              >
                Load more ({total - loaded} more)
              </Button>
            </div>
          )}
          {search.error && search.data && (
            <p role="alert" className="text-center text-sm text-status-error">
              Could not load more. {errorMessage(search.error)}
            </p>
          )}
        </div>
      )}

      {undo && (
        <UndoToast key={undo.id} entry={undo} onUndo={() => void runUndo(undo)} onClose={() => setUndo(null)} />
      )}
    </>
  );

  if (!canEdit) return shell(clipsView);

  return shell(
    <Tabs.Root value={tab} onValueChange={(v) => setTab(v as "clips" | "files")}>
      <Tabs.List aria-label="SocialSnippet views" className="-mb-px flex items-center gap-1 border-b border-border">
        {[
          { value: "clips", label: "Clips", icon: Scissors },
          { value: "files", label: "Files", icon: Files },
        ].map(({ value, label, icon: Icon }) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              "border-transparent text-text-secondary hover:text-text-primary",
              "data-[state=active]:border-accent data-[state=active]:text-accent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="clips" className="space-y-5 pt-5 focus:outline-none">
        {clipsView}
      </Tabs.Content>
      {/* Unmounted when not shown, so its 5 s polling stops with it. */}
      <Tabs.Content value="files" className="pt-5 focus:outline-none">
        <SnippetFilesTab projectId={projectId} canManage={canManage} />
      </Tabs.Content>
    </Tabs.Root>,
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading clips">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 rounded-xl border border-border bg-bg-secondary p-3 sm:grid-cols-[clamp(8.5rem,28%,14.5rem)_minmax(0,1fr)] sm:gap-x-4 sm:p-4"
        >
          <Skeleton className="aspect-[9/16] w-full rounded-lg" />
          <div className="space-y-2.5">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="mt-6 h-8 w-full" />
            <Skeleton className="h-8 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** "Saved · Undo" for the last change, gone after a few seconds. */
function UndoToast({ entry, onUndo, onClose }: { entry: UndoEntry; onUndo: () => void; onClose: () => void }) {
  React.useEffect(() => {
    const t = setTimeout(onClose, UNDO_TOAST_MS);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[55] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary shadow-xl"
    >
      <span className="min-w-0 flex-1 truncate">{entry.message}</span>
      <button
        type="button"
        onClick={onUndo}
        className="rounded px-1.5 py-0.5 hover-none:py-2 text-sm font-medium text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="rounded p-1 text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The keyboard shortcuts, in a small popover. */
function ShortcutsHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Keyboard shortcuts"
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <Keyboard className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">Shortcuts</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          collisionPadding={12}
          className="z-[60] w-72 rounded-md border border-border bg-bg-secondary p-3 shadow-xl"
        >
          <p className="mb-2 text-xs font-semibold text-text-primary">Keyboard shortcuts</p>
          <dl className="space-y-1.5 text-xs">
            {SHORTCUTS.map((s) => (
              <div key={s.label} className="flex items-center justify-between gap-3">
                <dt className="text-text-secondary">{s.label}</dt>
                <dd className="flex shrink-0 gap-1">
                  {s.keys.map((k) => (
                    <kbd
                      key={k}
                      className="min-w-[1.5rem] rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-center font-mono text-2xs text-text-primary"
                    >
                      {k}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-2xs text-text-tertiary">
            Not while typing in a field. Space, I, O and the arrows act on the clip that is playing; E on the clip
            with focus.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A filter dropdown with checkable options (speaker, topic). */
function PickerPopover({
  label,
  count,
  options,
  onToggle,
  empty,
}: {
  label: string;
  count: number;
  options: { key: string; label: string; on: boolean }[];
  onToggle: (key: string) => void;
  empty: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-3 h-8 hover-none:h-11 text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-border-focus",
          count > 0
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary",
        )}
      >
        {label}
        {count > 0 && <span className="tabular-nums">· {count}</span>}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-[60] w-60 max-h-72 overflow-y-auto rounded-md border border-border bg-bg-secondary p-1 shadow-xl"
        >
          {options.length === 0 ? (
            <p className="px-2 py-2 text-xs text-text-tertiary">{empty}</p>
          ) : (
            options.map((o) => (
              <label
                key={o.key}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover-none:py-2.5 text-sm text-text-primary hover:bg-bg-hover"
              >
                <input
                  type="checkbox"
                  checked={o.on}
                  onChange={() => onToggle(o.key)}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                <span className="truncate">{o.label}</span>
              </label>
            ))
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
