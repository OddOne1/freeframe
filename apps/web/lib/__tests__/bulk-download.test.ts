/**
 * What a multi-select "Download" means (§177).
 *
 * Two bugs are pinned here. One file routed into the zip dialog, so the
 * selection bar handed back `Project_Selected.zip` containing a single clip
 * that every other download path served as itself. And a folder selection
 * reached the server as a bare list of asset ids, with nothing left to say
 * that a folder — let alone WHICH folder — was what the user picked.
 */
import { describe, it, expect, vi } from 'vitest'

import {
  INDIVIDUAL_DOWNLOAD_LIMIT,
  classifySelection,
  planBulkDownload,
  type ZipScope,
} from '../bulk-download'

const NO_FOLDERS = async () => []

describe('classifying a selection (§177)', () => {
  it('calls loose files a selection', () => {
    expect(classifySelection(['a1', 'a2'], [])).toEqual({ scope: 'selected' })
  })

  it('calls one folder by its name', () => {
    expect(classifySelection([], ['f1'], () => 'Day 2 Rushes')).toEqual({
      scope: 'single_folder',
      folderName: 'Day 2 Rushes',
    })
  })

  it('calls several folders multiple_folders, with no name', () => {
    expect(classifySelection([], ['f1', 'f2'], () => 'Day 2')).toEqual({
      scope: 'multiple_folders',
    })
  })

  it('calls a folder mixed with loose files a selection, not a folder', () => {
    /* The archive holds things that are not in that folder, so naming it
       after the folder would describe contents it does not have. */
    expect(classifySelection(['a1'], ['f1'], () => 'Day 2')).toEqual({ scope: 'selected' })
  })

  it('never claims "all" — a grid selection is something the user picked', () => {
    const shapes: ZipScope[] = [
      classifySelection(['a1', 'a2'], []).scope,
      classifySelection([], ['f1']).scope,
      classifySelection([], ['f1', 'f2']).scope,
      classifySelection(['a1'], ['f1']).scope,
    ]
    expect(shapes).not.toContain('all')
  })

  it('still says single_folder when the name cannot be resolved', () => {
    /* The server falls back to `_Selected` for a nameless folder — better
       that than a lookup miss silently becoming a different shape. */
    expect(classifySelection([], ['f1'], () => undefined)).toEqual({
      scope: 'single_folder',
      folderName: undefined,
    })
  })
})

describe('one file is not a batch (§177)', () => {
  it('plans a direct download for exactly one asset and no folders', async () => {
    const plan = await planBulkDownload({
      assetIds: ['a1'],
      folderIds: [],
      expandFolder: NO_FOLDERS,
    })
    expect(plan).toEqual({ mode: 'single', assetId: 'a1' })
  })

  it('does not even list the folders for that case', async () => {
    const expandFolder = vi.fn(NO_FOLDERS)
    await planBulkDownload({ assetIds: ['a1'], folderIds: [], expandFolder })
    expect(expandFolder).not.toHaveBeenCalled()
  })

  it('zips two assets, which IS a batch', async () => {
    const plan = await planBulkDownload({
      assetIds: ['a1', 'a2'],
      folderIds: [],
      expandFolder: NO_FOLDERS,
    })
    expect(plan).toEqual({ mode: 'zip', assetIds: ['a1', 'a2'], scope: 'selected' })
  })

  it('zips a folder even when it holds a single file', async () => {
    /* The archive is what carries the folder structure, and the user picked
       a folder — unpacking it into a bare file throws that away. */
    const plan = await planBulkDownload({
      assetIds: [],
      folderIds: ['f1'],
      expandFolder: async () => ['a9'],
      folderNameById: () => 'Day 2',
    })
    expect(plan).toEqual({
      mode: 'zip',
      assetIds: ['a9'],
      scope: 'single_folder',
      folderName: 'Day 2',
    })
  })
})

describe('expanding folders', () => {
  it('folds folder contents in and de-duplicates', async () => {
    const plan = await planBulkDownload({
      assetIds: ['a1'],
      folderIds: ['f1', 'f2'],
      expandFolder: async (id) => (id === 'f1' ? ['a1', 'a2'] : ['a3']),
    })
    expect(plan.mode).toBe('zip')
    if (plan.mode !== 'zip') throw new Error('unreachable')
    expect(plan.assetIds).toEqual(['a1', 'a2', 'a3'])
    expect(plan.scope).toBe('selected')
  })

  it('skips a folder it cannot list rather than failing the download', async () => {
    const plan = await planBulkDownload({
      assetIds: ['a1', 'a2'],
      folderIds: ['broken'],
      expandFolder: async () => {
        throw new Error('403')
      },
    })
    expect(plan).toEqual({ mode: 'zip', assetIds: ['a1', 'a2'], scope: 'selected' })
  })

  it('plans nothing at all when the selection resolves to no files', async () => {
    const plan = await planBulkDownload({
      assetIds: [],
      folderIds: ['empty'],
      expandFolder: NO_FOLDERS,
    })
    expect(plan).toEqual({ mode: 'none' })
  })
})

describe('the individual-download limit', () => {
  it('is the same number on both surfaces, so a guest and a member agree', () => {
    expect(INDIVIDUAL_DOWNLOAD_LIMIT).toBe(50)
  })
})
