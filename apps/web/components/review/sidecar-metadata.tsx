'use client'

import * as React from 'react'
import useSWR from 'swr'
import { Upload, FileText, Loader2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { SidecarFile, SidecarParserMeta } from '@/types'

/**
 * Sidecar-derived metadata, rendered separately from the ffprobe/exiftool
 * block on purpose: that data is derived from the media file itself, this is
 * user-supplied and optional. Keeping the provenance visible ("From uploaded
 * sidecar") is the point.
 */

/** The only thing hidden here, per the spec — a deliberately minimal list,
 *  not a broad whitelist like the exiftool one. Tool/version fields say
 *  nothing about the shot. */
const HIDDEN_KEY_RE = /(software|firmware|generator|tool_?version|app_?version|writer)/i

function isHidden(key: string): boolean {
  // `_`-prefixed keys are parser bookkeeping (currently just `_meta`), not
  // metadata the shoot produced. Reserved on the backend for the same reason.
  return key.startsWith('_') || HIDDEN_KEY_RE.test(key)
}

/** Same rule as everywhere else: never render a row with no value. */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== '' && v.trim() !== '-'
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

function humanize(key: string): string {
  // Camera XML keys are dotted paths (Item.LensInfo.FocalLength) — keep the
  // leaf, which is the informative part, but don't pretend to fully
  // humanize a vendor schema this parser never understood.
  const leaf = key.includes('.') ? key.split('.').slice(-2).join(' › ') : key
  return leaf
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-text-tertiary shrink-0">{label}</span>
      <span className="text-xs text-text-primary text-right min-w-0 break-words">{value}</span>
    </div>
  )
}

/** Slope / Offset / Power as grouped RGB triplets — these relate directly to
 *  the LUT tooling, so they earn more than a flat key/value row. */
function CdlBlock({ correction }: { correction: Record<string, unknown> }) {
  const triplet = (name: string) => {
    const v = correction[name]
    return Array.isArray(v) && v.length === 3 ? (v as number[]) : null
  }
  const slope = triplet('slope')
  const offset = triplet('offset')
  const power = triplet('power')
  const sat = correction['saturation']

  const rows: Array<[string, number[] | null]> = [
    ['Slope', slope],
    ['Offset', offset],
    ['Power', power],
  ]

  return (
    <div className="rounded-md border border-border/60 p-2.5 space-y-2">
      {typeof correction.id === 'string' && (
        <p className="text-2xs uppercase tracking-wide text-text-tertiary">{correction.id}</p>
      )}
      <div className="space-y-1">
        {rows.map(([label, values]) =>
          values ? (
            <div key={label} className="flex items-center justify-between gap-2">
              <span className="text-xs text-text-tertiary w-14 shrink-0">{label}</span>
              <div className="flex gap-1.5 font-mono text-xs tabular-nums">
                {values.map((v, i) => (
                  <span
                    key={i}
                    className={cn(
                      'rounded px-1.5 py-0.5',
                      i === 0 && 'bg-red-500/10 text-red-300',
                      i === 1 && 'bg-green-500/10 text-green-300',
                      i === 2 && 'bg-blue-500/10 text-blue-300',
                    )}
                  >
                    {v.toFixed(4)}
                  </span>
                ))}
              </div>
            </div>
          ) : null,
        )}
      </div>
      {hasValue(sat) && <Row label="Saturation" value={String(sat)} />}
      {Array.isArray(correction.description) && correction.description.length > 0 && (
        <Row label="Description" value={(correction.description as string[]).join(', ')} />
      )}
    </div>
  )
}

function GenericRows({ data, prefix = '' }: { data: Record<string, unknown>; prefix?: string }) {
  const rows: React.ReactNode[] = []
  for (const [key, value] of Object.entries(data)) {
    if (isHidden(key) || !hasValue(value)) continue
    const label = humanize(prefix ? `${prefix}.${key}` : key)
    if (Array.isArray(value)) {
      rows.push(<Row key={key} label={label} value={value.map((v) => String(v)).join(', ')} />)
    } else if (typeof value === 'object') {
      rows.push(
        <GenericRows key={key} data={value as Record<string, unknown>} prefix={key} />,
      )
    } else {
      rows.push(<Row key={key} label={label} value={String(value)} />)
    }
  }
  return <>{rows}</>
}

function formatClock(seconds: number): string {
  const whole = Math.floor(seconds)
  const mm = String(Math.floor(whole / 60)).padStart(2, '0')
  const ss = String(whole % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** DJI flight telemetry: hundreds of per-frame samples, so the ranges and the
 *  field list lead, and the track itself stays collapsed. Rendering every
 *  sample as its own key/value row would bury everything else in the panel. */
function TelemetryBlock({ meta }: { meta: Record<string, unknown> }) {
  const samples = (meta.samples as Array<Record<string, unknown>>) ?? []
  const ranges = (meta.ranges as Record<string, { min: number; max: number }>) ?? {}
  const fields = (meta.fields as string[]) ?? []

  return (
    <div className="space-y-2">
      {hasValue(meta.sample_count) && (
        <Row label="Samples" value={String(meta.sample_count)} />
      )}
      {hasValue(meta.duration_seconds) && (
        <Row label="Duration" value={formatClock(Number(meta.duration_seconds))} />
      )}
      {hasValue(meta.first_timestamp) && (
        <Row label="Recorded" value={String(meta.first_timestamp)} />
      )}

      {Object.entries(ranges).map(([key, range]) => (
        <Row
          key={key}
          label={humanize(key)}
          value={
            <span className="font-mono tabular-nums">
              {range.min} → {range.max}
            </span>
          }
        />
      ))}

      {samples.length > 0 && (
        <details>
          <summary className="cursor-pointer text-2xs uppercase tracking-wide text-text-tertiary">
            Telemetry track
            {typeof meta.samples_downsampled === 'string'
              ? ` (${meta.samples_downsampled})`
              : ` (${samples.length})`}
          </summary>
          <div className="mt-1 max-h-56 overflow-y-auto space-y-1">
            {samples.map((sample, i) => {
              const pairs = Object.entries(sample).filter(
                ([k, v]) => k !== 't' && k !== 't_end' && hasValue(v),
              )
              return (
                <div key={i} className="flex items-start gap-2 text-2xs">
                  <span className="shrink-0 font-mono tabular-nums text-text-tertiary">
                    {formatClock(Number(sample.t))}
                  </span>
                  <span className="min-w-0 break-words text-text-secondary">
                    {pairs
                      .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                      .join(' · ')}
                  </span>
                </div>
              )
            })}
          </div>
        </details>
      )}

      {fields.length > 0 && <Row label="Fields" value={fields.join(', ')} />}
    </div>
  )
}

/** Says plainly when a parser was working without a spec. The alternative —
 *  rendering a best-effort read identically to a grounded one — is how a
 *  guessed value ends up being trusted downstream. */
function ConfidenceNote({ meta }: { meta: SidecarParserMeta }) {
  if (meta.confidence !== 'best_effort') return null
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-status-warning/30 bg-status-warning/5 px-2 py-1.5">
      <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-status-warning" />
      <p className="text-2xs text-text-tertiary">
        <span className="text-text-secondary">Unverified format. </span>
        {meta.note}
      </p>
    </div>
  )
}

function SidecarBody({ sidecar }: { sidecar: SidecarFile }) {
  const meta = sidecar.parsed_metadata ?? {}

  if (sidecar.sidecar_type === 'dji_srt') {
    return <TelemetryBlock meta={meta} />
  }

  if (sidecar.sidecar_type === 'cdl') {
    const corrections = (meta.color_corrections as Array<Record<string, unknown>>) ?? []
    if (corrections.length === 0) return null
    return (
      <div className="space-y-2">
        {corrections.map((c, i) => (
          <CdlBlock key={(c.id as string) ?? i} correction={c} />
        ))}
      </div>
    )
  }

  if (sidecar.sidecar_type === 'ale') {
    const clips = (meta.clips as Array<Record<string, unknown>>) ?? []
    const heading = (meta.heading as Record<string, unknown>) ?? {}
    return (
      <div className="space-y-2">
        {clips.map((clip, i) => (
          <div key={i}>
            <GenericRows data={clip} />
          </div>
        ))}
        {Object.keys(heading).length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer text-2xs uppercase tracking-wide text-text-tertiary">
              File info
            </summary>
            <div className="pt-1">
              <GenericRows data={heading} />
            </div>
          </details>
        )}
      </div>
    )
  }

  return <GenericRows data={meta} />
}

const TYPE_LABEL: Record<string, string> = {
  cdl: 'ASC CDL',
  ale: 'ALE',
  camera_xml: 'Camera XML',
  dji_srt: 'DJI telemetry',
  panasonic_clipinfo: 'Clip info (AVCHD)',
  nikon_nksc: 'Nikon sidecar',
  red_rmd: 'RED metadata',
  sony_bim: 'Sony clip metadata',
  canon_cif: 'Canon clip info',
}

/**
 * The sidecar rows themselves, with no fetching and no upload control.
 *
 * Split out so a share-link viewer at Fields level `full` renders exactly
 * these rows (CLAUDE.md §33) from data it received over a share-token
 * route, rather than a second implementation that would drift from the
 * provenance/confidence treatment this one carefully does.
 */
export function SidecarList({ sidecars }: { sidecars: SidecarFile[] }) {
  return (
    <div className="space-y-3">
      {sidecars.map((s) => {
        const parserMeta = (s.parsed_metadata?._meta ?? null) as SidecarParserMeta | null
        return (
          <div key={s.id} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-text-tertiary shrink-0" />
              <span className="text-2xs text-text-tertiary truncate">
                {TYPE_LABEL[s.sidecar_type] ?? s.sidecar_type} · {s.original_filename}
              </span>
            </div>
            {parserMeta && <ConfidenceNote meta={parserMeta} />}
            <SidecarBody sidecar={s} />
          </div>
        )
      })}
    </div>
  )
}

export function SidecarMetadata({
  assetId,
  canEdit,
}: {
  assetId: string
  canEdit: boolean
}) {
  const { data, isLoading, mutate } = useSWR<SidecarFile[]>(
    assetId ? `/assets/${assetId}/sidecars` : null,
    (key: string) => api.get<SidecarFile[]>(key),
  )

  const fileRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      await api.upload(`/assets/${assetId}/sidecars`, form)
      await mutate()
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'detail' in err
          ? String((err as { detail: unknown }).detail)
          : 'Could not attach sidecar'
      setError(detail)
    } finally {
      setUploading(false)
    }
  }

  const sidecars = data ?? []
  if (!canEdit && sidecars.length === 0 && !isLoading) return null

  return (
    <div className="pt-4">
      <div className="flex items-center justify-between gap-2 pb-2 mb-1 border-b border-border/60">
        <h3 className="text-xs font-medium text-text-secondary">From uploaded sidecar</h3>
        {canEdit && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".cdl,.cc,.ccc,.ale,.xml,.srt,.cpi,.nksc,.rmd,.bim,.cif"
              onChange={handleFile}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1 text-2xs text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-60"
            >
              {uploading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              Attach sidecar
            </button>
          </>
        )}
      </div>

      {error && <p className="text-2xs text-status-error pb-2">{error}</p>}

      {isLoading ? (
        <div className="h-8 rounded bg-bg-tertiary animate-pulse" />
      ) : sidecars.length === 0 ? (
        <p className="text-2xs text-text-tertiary py-1">
          No sidecar attached. CDL, ALE, camera XML, DJI telemetry and
          camera-native clip metadata are matched by filename on upload.
        </p>
      ) : (
        <SidecarList sidecars={sidecars} />
      )}
    </div>
  )
}
