/**
 * Keeping folder structure on upload (CLAUDE.md §49).
 *
 * Asserted on the source rather than by rendering: this page pulls in SWR,
 * the upload store, the review provider and a dozen dialogs, and what
 * changed here is a handful of rules — filter to usable files, ask only when
 * a folder was involved, create each folder once, thread the resulting id
 * into startUpload. Structural assertions pin exactly those and say so.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const PAGE = fs.readFileSync(
  path.join(process.cwd(), 'app/(dashboard)/projects/[id]/page.tsx'),
  'utf8',
)
const ZONE = fs.readFileSync(
  path.join(process.cwd(), 'components/upload/upload-zone.tsx'),
  'utf8',
)

describe('§49 — the dropped tree reaches the uploader', () => {
  it('reads dataTransfer.items, not just .files', () => {
    // `.files` flattens a dropped folder and loses everything nested; that
    // was the whole bug.
    expect(ZONE).toMatch(/readDroppedEntries\(e\.dataTransfer\)/)
    // The fallback stays for browsers that do not populate `items`.
    expect(ZONE).toMatch(/handleFiles\(e\.dataTransfer\.files\)/)
  })

  it('uses the shared walk rather than a second copy', () => {
    expect(ZONE).toMatch(/from '@\/lib\/read-dropped-entries'/)
    const LUTS = fs.readFileSync(
      path.join(process.cwd(), 'app/(dashboard)/settings/luts/page.tsx'),
      'utf8',
    )
    // The LUT page had the only correct implementation; it now imports it.
    expect(LUTS).toMatch(/readDroppedEntries/)
    expect(LUTS).not.toMatch(/createReader\(\)/)
  })
})

describe('§49 — filtering', () => {
  it('keeps only media and sidecars, dropping junk silently', () => {
    expect(PAGE).toMatch(
      /!isCameraJunkFile\(d\.file\) && \(isMediaFile\(d\.file\) \|\| isSidecarFile\(d\.file\)\)/,
    )
  })

  it('still splits sidecars out of the media loop', () => {
    // Unchanged behaviour: a sidecar must not become an unplayable asset.
    expect(PAGE).toMatch(/const sidecars = pendingFiles\.filter\(\(d\) => isSidecarFile\(d\.file\)\)/)
    expect(PAGE).toMatch(/uploadSidecars\(sidecars\.map\(\(d\) => d\.file\)/)
  })
})

describe('§49 — structure', () => {
  it('asks only when a folder was actually involved', () => {
    expect(PAGE).toMatch(/pendingFiles\.some\(\(d\) => d\.path\.length > 0\) && \(/)
  })

  it('creates each folder once per batch, not once per file', () => {
    expect(PAGE).toMatch(/const folderCache = new Map<string, string \| null>\(\)/)
    expect(PAGE).toMatch(/ensureFolderPath\(entry\.path, folderCache\)/)
  })

  it('nests under the folder currently being viewed', () => {
    expect(PAGE).toMatch(/let parent: string \| null = currentFolderId/)
    expect(PAGE).toMatch(/parent_id: parent/)
  })

  it('flatten sends the current folder, which is today’s behaviour unchanged', () => {
    expect(PAGE).toMatch(/: currentFolderId;/)
  })

  it('threads the resolved folder into startUpload', () => {
    expect(PAGE).toMatch(/startUpload\(entry\.file, projectId, name, project\?\.name, folderId\)/)
    // The standing "startUpload does not yet accept folderId" comment was
    // stale — it already did — and is gone.
    expect(PAGE).not.toMatch(/startUpload does not yet accept folderId/)
  })
})
