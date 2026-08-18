'use client'

import * as React from 'react'
import type { TechnicalMetadata } from '@/types'

/**
 * The file's own technical metadata (ffprobe + exiftool), rendered as a
 * label/value list.
 *
 * Extracted from the asset detail page so the share viewers can show the
 * same thing at Fields level `full` (CLAUDE.md §33) without a second,
 * inevitably-diverging copy of this field table. The table encodes real
 * decisions — which EXIF fields are deliberately hidden, why codec level is
 * shown raw — and those comments are the reason it must not be duplicated.
 *
 * Presentational only: no fetching, no permissions. Whether a viewer is
 * allowed to see this is decided server-side.
 */

export function formatBitrate(bps?: number | null): string | null {
  if (!bps) return null
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`
  return `${bps} bps`
}

function formatSampleRate(hz?: number | null): string | null {
  if (!hz) return null
  return `${(hz / 1000).toFixed(1)} kHz`
}

const TECHNICAL_METADATA_FIELDS: Array<{
  key: keyof TechnicalMetadata
  label: string
  format?: (v: any) => string
}> = [
  { key: 'camera_make', label: 'Camera make' },
  { key: 'camera_model', label: 'Camera model' },
  { key: 'timecode', label: 'Timecode' },
  {
    key: 'creation_time',
    label: 'Recorded',
    format: (v) => {
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString()
    },
  },
  { key: 'video_codec', label: 'Video codec' },
  { key: 'video_codec_profile', label: 'Codec profile' },
  // Shown as ffprobe's raw integer, not converted to e.g. "4.1" -- the
  // level-to-human-string scale differs by codec (H.264 vs HEVC vs AV1),
  // and guessing wrong would show a plausible-looking but incorrect number.
  { key: 'video_codec_level', label: 'Codec level' },
  { key: 'video_bit_rate', label: 'Video bitrate', format: (v) => formatBitrate(v) ?? String(v) },
  { key: 'visual_bit_depth', label: 'Bit depth', format: (v) => `${v}-bit` },
  { key: 'alpha_channel', label: 'Alpha channel', format: (v) => (v ? 'Yes' : 'No') },
  { key: 'color_space', label: 'Color space' },
  { key: 'color_primaries', label: 'Color primaries' },
  { key: 'color_transfer', label: 'Color transfer' },
  { key: 'dynamic_range', label: 'Dynamic range' },
  { key: 'field_order', label: 'Field order' },
  { key: 'display_aspect_ratio', label: 'Aspect ratio' },
  { key: 'rotation', label: 'Rotation', format: (v) => `${v}°` },
  { key: 'encoder', label: 'Encoder' },
  { key: 'audio_codec', label: 'Audio codec' },
  { key: 'audio_bit_rate', label: 'Audio bitrate', format: (v) => formatBitrate(v) ?? String(v) },
  { key: 'audio_bit_depth', label: 'Audio bit depth', format: (v) => `${v}-bit` },
  { key: 'audio_channels', label: 'Audio channels' },
  { key: 'audio_sample_rate', label: 'Audio sample rate', format: (v) => formatSampleRate(v) ?? String(v) },

  // ── EXIF pass (exiftool, 2026-07-30) ──
  // Everything captured by parse_exiftool_metadata is visible EXCEPT five
  // fields, per the user's final decision: ycbcr_positioning,
  // components_configuration, exif_version, interoperability_index and
  // interoperability_version. Those are stored but deliberately absent from
  // this array -- same hide-but-don't-lose mechanism as GPS
  // (gps_latitude/gps_longitude/gps_altitude, also intentionally missing
  // here). An earlier draft of the spec proposed hiding compression, the
  // resolution fields, compressed_bits_per_pixel, flashpix_version and
  // file_source too; the user explicitly overruled that, so they are listed.
  { key: 'software', label: 'Software' },
  { key: 'exif_orientation', label: 'Orientation' },
  {
    key: 'date_time_original',
    label: 'Shot',
    format: (v) => formatExifDate(v),
  },
  {
    key: 'date_time_digitized',
    label: 'Digitized',
    format: (v) => formatExifDate(v),
  },
  {
    key: 'date_time',
    label: 'Modified',
    format: (v) => formatExifDate(v),
  },
  { key: 'exposure_time', label: 'Shutter speed', format: (v) => (String(v).includes('/') ? `${v} s` : `${v} s`) },
  { key: 'f_number', label: 'Aperture', format: (v) => `f/${v}` },
  { key: 'focal_length', label: 'Focal length' },
  { key: 'exposure_program', label: 'Exposure program' },
  { key: 'exposure_bias', label: 'Exposure bias' },
  { key: 'max_aperture_value', label: 'Max aperture', format: (v) => `f/${v}` },
  { key: 'metering_mode', label: 'Metering mode' },
  { key: 'flash', label: 'Flash' },
  { key: 'exif_color_space', label: 'EXIF color space' },
  { key: 'compression', label: 'Compression' },
  { key: 'x_resolution', label: 'X resolution' },
  { key: 'y_resolution', label: 'Y resolution' },
  { key: 'resolution_unit', label: 'Resolution unit' },
  { key: 'compressed_bits_per_pixel', label: 'Compressed bits/pixel' },
  { key: 'flashpix_version', label: 'FlashPix version' },
  { key: 'file_source', label: 'File source' },
]

/** EXIF timestamps are "YYYY:MM:DD HH:MM:SS", which Date() will not parse.
 *  Falls back to the raw string rather than showing "Invalid Date". */
function formatExifDate(v: unknown): string {
  const raw = String(v)
  const normalized = raw.replace(
    /^(\d{4}):(\d{2}):(\d{2})/,
    (_m, y, mo, d) => `${y}-${mo}-${d}`,
  )
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString()
}

export function TechnicalMetadataList({ metadata }: { metadata: TechnicalMetadata }) {
  const rows = TECHNICAL_METADATA_FIELDS
    .filter((f) => metadata[f.key] !== undefined && metadata[f.key] !== null)
    .map((f) => ({
      label: f.label,
      value: f.format ? f.format(metadata[f.key]) : String(metadata[f.key]),
    }))

  if (rows.length === 0) return null

  return (
    <div className="mt-1.5 rounded-md border border-border/60 divide-y divide-border/60">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <span className="text-xs text-text-tertiary">{r.label}</span>
          <span className="text-xs text-text-primary font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  )
}
