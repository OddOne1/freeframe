/**
 * Subgroup-aware folder upload and the raised size cap (CLAUDE.md §52).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutThumbnail: () => Promise.resolve('d'),
  getCachedLutThumbnail: () => 'd',
  renderLutPreview: () => Promise.resolve('d'),
  getCachedLutPreview: () => null,
}))

const get = vi.fn()
const post = vi.fn()
const patch = vi.fn()
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b: unknown) => post(p, b),
    patch: (p: string, b: unknown) => patch(p, b),
    delete: vi.fn(),
    upload: (p: string, f: FormData) => upload(p, f),
  },
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: false }) }))

import LutsSettingsPage from '../page'

let created = 0
let groups = 0
beforeEach(() => {
  created = 0
  groups = 0
  window.localStorage.clear()
  ;[get, post, patch, upload].forEach((m) => m.mockReset())
  patch.mockResolvedValue({})
  post.mockImplementation(() => Promise.resolve({ id: `g${++groups}` }))
  upload.mockImplementation(() => Promise.resolve({ id: `lut-${++created}` }))
  get.mockImplementation(() => Promise.resolve([]))
})

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LutsSettingsPage />
    </SWRConfig>,
  )
}

async function openUploader() {
  await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))
  return screen.findByTestId('lut-drop-zone')
}

function file(name: string) {
  const f = new File(['LUT_3D_SIZE 2\n'], name, { type: 'text/plain' })
  Object.defineProperty(f, 'size', { value: 10 })
  return f
}

function fileEntry(name: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb: (f: File) => void) => cb(file(name)),
  } as unknown as FileSystemEntry
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false
      return {
        readEntries: (cb: (e: FileSystemEntry[]) => void) => {
          if (done) return cb([])
          done = true
          cb(children)
        },
      }
    },
  } as unknown as FileSystemEntry
}

async function drop(entries: FileSystemEntry[]) {
  const zone = await openUploader()
  fireEvent.drop(zone, {
    dataTransfer: {
      types: ['Files'],
      files: [],
      items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    },
  })
}

describe('the size cap', () => {
  it('is 129 on both sides, and they say so', () => {
    const api = fs.readFileSync(
      path.join(process.cwd(), '../api/routers/luts.py'),
      'utf8',
    )
    const parser = fs.readFileSync(
      path.join(process.cwd(), 'lib/lut/cube-parser.ts'),
      'utf8',
    )
    expect(api).toMatch(/MAX_LUT_SIZE = 129/)
    expect(parser).toMatch(/const MAX_SIZE = 129/)
    // The two must track each other; the comment on each says which.
    expect(parser).toMatch(/MAX_LUT_SIZE in apps\/api\/routers\/luts\.py/)
    expect(api).toMatch(/apps\/web\/lib\/lut\/cube-parser\.ts/)
  })

  it('still rejects nonsense, just at the new ceiling', async () => {
    const { parseCube } = await import('@/lib/lut/cube-parser')
    expect(() => parseCube('LUT_3D_SIZE 9999\n')).toThrow(/2–129/)
    // ...and a 65-point LUT, the size that started this, is now a valid
    // header rather than a rejection.
    expect(() => parseCube('LUT_3D_SIZE 65\n0.0 0.0 0.0\n')).not.toThrow(/must be 2/)
  })
})

describe('a dropped folder with subfolders', () => {
  const tree = () => [
    dirEntry('Leica Looks', [
      fileEntry('loose.cube'),
      dirEntry('Rec2020', [fileEntry('a.cube'), fileEntry('b.cube')]),
      dirEntry('Cine', [fileEntry('c.cube')]),
    ]),
  ]

  it('names the root and every subfolder in the prompt', async () => {
    renderPage()
    await drop(tree())

    const prompt = await screen.findByText(/into a group of that name/)
    expect(prompt).toHaveTextContent('Leica Looks')
    expect(prompt).toHaveTextContent('2 sub-groups')
    expect(prompt).toHaveTextContent('Rec2020, Cine')
  })

  it('creates the root first, then each subgroup under it', async () => {
    renderPage()
    await drop(tree())
    await screen.findByText(/into a group of that name/)
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
    expect(post.mock.calls[0][1]).toEqual({ name: 'Leica Looks', parent_group_id: null })
    // Subgroups carry the root's id — the same one-level nesting §45 built.
    expect(post.mock.calls[1][1]).toEqual({ name: 'Rec2020', parent_group_id: 'g1' })
    expect(post.mock.calls[2][1]).toEqual({ name: 'Cine', parent_group_id: 'g1' })
  })

  it('files each LUT into its own subgroup, not all into the root', async () => {
    renderPage()
    await drop(tree())
    await screen.findByText(/into a group of that name/)
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(4))
    const byLut = Object.fromEntries(
      patch.mock.calls.map((c) => [c[0], (c[1] as { group_id: string }).group_id]),
    )
    // Upload order: loose, a, b, c.
    expect(byLut['/me/luts/lut-1']).toBe('g1') // root — sat directly in it
    expect(byLut['/me/luts/lut-2']).toBe('g2') // Rec2020
    expect(byLut['/me/luts/lut-3']).toBe('g2')
    expect(byLut['/me/luts/lut-4']).toBe('g3') // Cine
  })

  it('folds a third level into its first subfolder, since groups are one deep', async () => {
    renderPage()
    await drop([
      dirEntry('Root', [dirEntry('Sub', [dirEntry('Deeper', [fileEntry('x.cube')])])]),
    ])

    const prompt = await screen.findByText(/into a group of that name/)
    // "Deeper" is not offered as a group — it cannot be one — but its file
    // is not dropped either: it lands in Sub.
    expect(prompt).toHaveTextContent('Sub')
    expect(prompt).not.toHaveTextContent('Deeper')

    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0][1]).toEqual({ group_id: 'g2' })
  })
})

describe('a flat folder', () => {
  it('is unchanged — one group, no subgroups', async () => {
    renderPage()
    await drop([dirEntry('Flat', [fileEntry('a.cube'), fileEntry('b.cube')])])

    const prompt = await screen.findByText(/into a group of that name/)
    expect(prompt).not.toHaveTextContent('sub-group')

    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][1]).toEqual({ name: 'Flat', parent_group_id: null })
  })
})
