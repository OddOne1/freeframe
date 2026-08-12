/**
 * Multi-select member management + the AddView permission gate
 * (CLAUDE.md §15/§16).
 *
 * Rendered for real rather than unit-testing the handlers, because the
 * things most likely to be wrong here are which rows get a checkbox and
 * which UI is shown to whom — neither of which a direct call to a handler
 * would exercise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProjectRole, User } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const authState = { user: null as User | null, isSuperAdmin: false }
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => authState,
}))

import { api } from '@/lib/api'
import { ProjectMembersDialog } from '../project-members-dialog'

const OWNER = 'u-owner'
const ME = 'u-me'
const ALICE = 'u-alice'
const BOB = 'u-bob'

function user(id: string, name: string): User {
  return {
    id, email: `${id}@example.com`, name,
    first_name: name.split(' ')[0], last_name: name.split(' ')[1] ?? '',
    avatar_url: null, status: 'active', role: 'superuser',
    email_verified: true, preferences: {},
    created_at: '2026-01-01T00:00:00Z', deleted_at: null,
  } as unknown as User
}

/** members = [{user_id, role}] — `me` decides which row is the viewer. */
function mockApi(members: { user_id: string; role: ProjectRole }[]) {
  const users: Record<string, User> = {
    [OWNER]: user(OWNER, 'Olivia Owner'),
    [ME]: user(ME, 'Me Myself'),
    [ALICE]: user(ALICE, 'Alice Editor'),
    [BOB]: user(BOB, 'Bob Viewer'),
  }
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.includes('/members')) {
      return members.map((m, i) => ({ id: `m${i}`, ...m })) as never
    }
    if (path.startsWith('/users?ids=')) {
      const ids = decodeURIComponent(path.split('ids=')[1]).split(',')
      return ids.map((id) => users[id]).filter(Boolean) as never
    }
    return [] as never
  })
}

function renderDialog(props: Partial<React.ComponentProps<typeof ProjectMembersDialog>> = {}) {
  return render(
    <ProjectMembersDialog
      open
      onOpenChange={() => {}}
      projectId="p1"
      projectName="Test Project"
      {...props}
    />,
  )
}

const ADMIN_SET = [
  { user_id: OWNER, role: 'owner' as ProjectRole },
  { user_id: ME, role: 'admin' as ProjectRole },
  { user_id: ALICE, role: 'editor' as ProjectRole },
  { user_id: BOB, role: 'viewer' as ProjectRole },
]

beforeEach(() => {
  vi.clearAllMocks()
  authState.user = user(ME, 'Me Myself')
  authState.isSuperAdmin = false
})

// ─── Step 0: AddView's permission gate ──────────────────────────────────

describe('AddView permission gate', () => {
  it('shows the add UI to an owner/admin member', async () => {
    mockApi(ADMIN_SET)
    renderDialog()
    expect(await screen.findByPlaceholderText('Name or email')).toBeInTheDocument()
  })

  it('hides it from a plain member, landing them on Manage instead', async () => {
    mockApi([
      { user_id: OWNER, role: 'owner' },
      { user_id: ME, role: 'editor' },   // not owner/admin
    ])
    renderDialog()
    await screen.findByText('Members of Test Project')
    expect(screen.queryByPlaceholderText('Name or email')).not.toBeInTheDocument()
  })

  it('shows it to a superadmin who has JOINED, even at viewer level', async () => {
    // Mirrors _require_project_member_manager: a membership row plus
    // superadmin is enough to add.
    authState.isSuperAdmin = true
    mockApi([
      { user_id: OWNER, role: 'owner' },
      { user_id: ME, role: 'viewer' },
    ])
    renderDialog()
    expect(await screen.findByPlaceholderText('Name or email')).toBeInTheDocument()
  })

  it('hides it from a superadmin who has NOT joined', async () => {
    // The exact case wiring the superadmin table to this dialog would
    // otherwise have exposed: a live add UI that 403s on submit.
    authState.isSuperAdmin = true
    mockApi([{ user_id: OWNER, role: 'owner' }])   // no row for ME
    renderDialog()
    await screen.findByText('Members of Test Project')
    expect(screen.queryByPlaceholderText('Name or email')).not.toBeInTheDocument()
  })
})

// ─── Step 2: which rows are selectable ──────────────────────────────────

describe('multi-select checkboxes', () => {
  it('omits the checkbox for the owner and for yourself', async () => {
    mockApi(ADMIN_SET)
    renderDialog()
    await screen.findByPlaceholderText('Name or email')
    await userEvent.click(screen.getByText('Manage'))

    expect(screen.getByLabelText('Select Alice Editor')).toBeInTheDocument()
    expect(screen.getByLabelText('Select Bob Viewer')).toBeInTheDocument()
    // Not merely disabled — absent.
    expect(screen.queryByLabelText('Select Olivia Owner')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Select Me Myself')).not.toBeInTheDocument()
  })

  it('shows no checkboxes at all to someone who cannot manage', async () => {
    mockApi([
      { user_id: OWNER, role: 'owner' },
      { user_id: ME, role: 'editor' },
      { user_id: ALICE, role: 'editor' },
    ])
    renderDialog()
    await screen.findByText('Members of Test Project')
    expect(screen.queryByLabelText('Select Alice Editor')).not.toBeInTheDocument()
  })

  it('select-all covers exactly the selectable rows', async () => {
    mockApi(ADMIN_SET)
    renderDialog()
    await screen.findByPlaceholderText('Name or email')
    await userEvent.click(screen.getByText('Manage'))

    await userEvent.click(screen.getByText('Select all (2)'))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })
})

// ─── Step 3: bulk actions, and partial failure ──────────────────────────

describe('bulk actions', () => {
  async function selectBoth() {
    mockApi(ADMIN_SET)
    renderDialog()
    await screen.findByPlaceholderText('Name or email')
    await userEvent.click(screen.getByText('Manage'))
    await userEvent.click(screen.getByLabelText('Select Alice Editor'))
    await userEvent.click(screen.getByLabelText('Select Bob Viewer'))
    await screen.findByText('2 selected')
  }

  it('fires one DELETE per selected member against the existing endpoint', async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined as never)
    await selectBoth()

    await userEvent.click(screen.getByText('Remove selected'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2))
    expect(api.delete).toHaveBeenCalledWith(`/projects/p1/members/${ALICE}`)
    expect(api.delete).toHaveBeenCalledWith(`/projects/p1/members/${BOB}`)
  })

  it('requires confirmation before removing', async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined as never)
    await selectBoth()

    await userEvent.click(screen.getByText('Remove selected'))
    expect(screen.getByText('Remove 2 members?')).toBeInTheDocument()
    expect(api.delete).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('reports WHICH member failed and the API message, not just a count', async () => {
    // The scenario the prompt asks for: a mixed selection where one fails.
    vi.mocked(api.delete).mockImplementation(async (path: string) => {
      if (path.endsWith(BOB)) throw new Error("can't remove the project owner")
      return undefined as never
    })
    await selectBoth()

    await userEvent.click(screen.getByText('Remove selected'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    // Both were attempted — allSettled, not all.
    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('1 of 2 updated')).toBeInTheDocument()
    expect(
      await screen.findByText("Bob Viewer: can't remove the project owner"),
    ).toBeInTheDocument()
  })

  it('keeps only the failures selected, so a retry does not repeat successes', async () => {
    vi.mocked(api.delete).mockImplementation(async (path: string) => {
      if (path.endsWith(BOB)) throw new Error('nope')
      return undefined as never
    })
    await selectBoth()

    await userEvent.click(screen.getByText('Remove selected'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  })

  it('bulk role change PATCHes each selected member', async () => {
    vi.mocked(api.patch).mockResolvedValue(undefined as never)
    await selectBoth()

    await userEvent.click(screen.getByText('Set role'))
    await userEvent.click(await screen.findByText('Comment Only'))

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2))
    expect(api.patch).toHaveBeenCalledWith(`/projects/p1/members/${ALICE}`, { role: 'reviewer' })
    expect(api.patch).toHaveBeenCalledWith(`/projects/p1/members/${BOB}`, { role: 'reviewer' })
  })

  it('never builds a bulk endpoint', async () => {
    vi.mocked(api.delete).mockResolvedValue(undefined as never)
    await selectBoth()
    await userEvent.click(screen.getByText('Remove selected'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(2))
    for (const [path] of vi.mocked(api.delete).mock.calls) {
      expect(path).toMatch(/^\/projects\/p1\/members\/u-/)
    }
    expect(api.post).not.toHaveBeenCalled()
  })
})

// ─── Step 4: cross-navigation ───────────────────────────────────────────

describe('cross-navigation to Settings', () => {
  it('offers it to a project admin when the parent supplies the handler', async () => {
    mockApi(ADMIN_SET)
    const onOpenSettings = vi.fn()
    renderDialog({ onOpenSettings })

    await userEvent.click(await screen.findByText('Settings'))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('is absent when the parent supplies no handler', async () => {
    mockApi(ADMIN_SET)
    renderDialog()
    await screen.findByPlaceholderText('Name or email')
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
  })
})
