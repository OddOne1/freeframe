/**
 * §241 item 1 — `include_deleted=true` is asked for on ONE list.
 *
 * The removed versions belong in the version dropdown. Everything else
 * that reads versions — the provider that feeds the player, §242's live
 * list, the share pages' own queries — must keep seeing live versions
 * only, or a deleted row becomes a candidate for selection, for
 * "highest ready", and for a player with no media to play.
 *
 * Two tests, for the two ways that can break: the hook asks for the right
 * key, and nothing else in the app asks for the parameter at all. The
 * second is a source scan rather than a render, because the failure it
 * guards against is somebody adding the parameter to the provider's fetch
 * — which no amount of rendering this hook would notice.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const get = vi.fn(async (_path: string) => [] as unknown[])
vi.mock('@/lib/api', () => ({
  api: { get: (p: string) => get(p) },
  ApiError: class extends Error {},
}))

import {
  deletedVersionsKey,
  shouldSelectRestored,
  useDeletedVersions,
} from '../use-deleted-versions'
import type { AssetVersion } from '@/types'

describe('the deleted-versions hook', () => {
  it('fetches the asset’s versions with include_deleted=true', async () => {
    renderHook(() => useDeletedVersions('a-1'))
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/assets/a-1/versions?include_deleted=true'),
    )
    expect(deletedVersionsKey('a-1')).toBe('/assets/a-1/versions?include_deleted=true')
  })

  it('asks for nothing when disabled — share mode never calls this route', async () => {
    get.mockClear()
    renderHook(() => useDeletedVersions('a-1', false))
    await new Promise((r) => setTimeout(r, 20))
    expect(get).not.toHaveBeenCalled()
  })

  it('returns only the rows the server marked deleted', async () => {
    get.mockImplementation(async () => [
      { id: 'v1', version_number: 1, deleted_at: null },
      { id: 'v2', version_number: 2, deleted_at: '2026-10-01T00:00:00Z' },
    ] as never)
    const { result } = renderHook(() => useDeletedVersions('a-2'))
    await waitFor(() => expect(result.current.removedVersions).toHaveLength(1))
    expect(result.current.removedVersions[0].id).toBe('v2')
  })
})

/** Every .ts/.tsx under the app's own source, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('include_deleted is used in exactly one place', () => {
  it('appears only in the hook that owns that list', () => {
    const root = join(__dirname, '..', '..')
    const hits = sourceFiles(root)
      .filter((f) => readFileSync(f, 'utf8').includes('include_deleted'))
      .map((f) => f.slice(root.length + 1))
    expect(hits).toEqual(['hooks/use-deleted-versions.ts'])
  })
})

// ─── Where a restore leaves the user ─────────────────────────────────────

const v = (n: number, status = 'ready'): AssetVersion =>
  ({ id: `v-${n}`, version_number: n, processing_status: status }) as AssetVersion

describe('after a restore, the selection', () => {
  it('moves to the restored version when it is the highest and ready', () => {
    expect(shouldSelectRestored(v(3), [v(1), v(2), v(3)])).toBe(true)
  })

  it('stays put when an older version came back', () => {
    // Somebody reviewing v7 must not be moved to the v2 they restored.
    expect(shouldSelectRestored(v(2), [v(1), v(2), v(7)])).toBe(false)
  })

  it('stays put when the restored version is not ready to watch', () => {
    expect(shouldSelectRestored(v(3, 'processing'), [v(1), v(3, 'processing')])).toBe(false)
    expect(shouldSelectRestored(v(3, 'failed'), [v(1), v(3, 'failed')])).toBe(false)
  })

  it('stays put when the restore could not be read back', () => {
    expect(shouldSelectRestored(undefined, [v(1)])).toBe(false)
  })
})
