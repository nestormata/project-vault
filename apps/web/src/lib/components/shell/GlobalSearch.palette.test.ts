import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const mockedPage = vi.hoisted(() => ({
  data: { user: { orgRole: 'owner', userId: 'u1' } } as { user?: Record<string, unknown> },
}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: mockedPage }))

import GlobalSearch from './GlobalSearch.svelte'
import { addRecent, clearRecents } from './palette-recents.js'
import { projectResult, searchResponse } from './global-search-test-helpers.js'

type Handler = (url: string) => Response | undefined

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

function installFetch(handler: Handler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return handler(url) ?? json(404, { code: 'not_found', message: 'nope' })
    })
  )
}

const projectBody = (id: string, role: string) =>
  json(200, { data: { id, name: `Project ${id}`, role, archivedAt: null, tags: [] } })

function openPalette() {
  return render(GlobalSearch, { props: { open: true } })
}

function optionLabels(): string[] {
  return screen
    .queryAllByRole('option')
    .map((o) => o.textContent?.replace(/\s+/g, ' ').trim() ?? '')
}

const SETTLE_MS = 30

describe('GlobalSearch palette actions and recents (Story 72.5)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    clearRecents()
    mockedPage.data = { user: { orgRole: 'owner', userId: 'u1' } }
    installFetch(() => undefined)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('an owner sees the action group with an empty query', async () => {
    openPalette()
    expect(await screen.findByText('Create project')).toBeTruthy()
    expect(screen.getByText('Go to Audit log')).toBeTruthy()
    expect(screen.getByText('Actions')).toBeTruthy()
  })

  it('a viewer sees no action: authorization first', async () => {
    mockedPage.data = { user: { orgRole: 'viewer', userId: 'u2' } }
    openPalette()
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    expect(optionLabels()).toEqual([])
    expect(screen.queryByText('Create project')).toBeNull()
  })

  it('a member sees Create project but not the audit log', async () => {
    mockedPage.data = { user: { orgRole: 'member', userId: 'u3' } }
    openPalette()
    expect(await screen.findByText('Create project')).toBeTruthy()
    expect(screen.queryByText('Go to Audit log')).toBeNull()
  })

  it('selecting an action navigates to its route', async () => {
    openPalette()
    await fireEvent.click(await screen.findByText('Go to Audit log'))
    expect(gotoMock).toHaveBeenCalledWith('/settings/audit')
  })

  it('New secret in X appears only for a project the user can write to', async () => {
    installFetch((url) => {
      if (url.startsWith('/api/v1/search')) return searchResponse([projectResult], 'infra')
      if (url === '/api/v1/projects/proj-2') return projectBody('proj-2', 'member')
      return undefined
    })
    openPalette()
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'infra' } })
    expect(
      await screen.findByText('New secret in Project proj-2', {}, { timeout: 2000 })
    ).toBeTruthy()
    expect(screen.queryByText('Create project')).toBeNull()
    await fireEvent.click(screen.getByText('New secret in Project proj-2'))
    expect(gotoMock).toHaveBeenCalledWith('/projects/proj-2/credentials/new')
  })

  it('a project where the user is only a viewer offers no New secret action', async () => {
    mockedPage.data = { user: { orgRole: 'member', userId: 'u4' } }
    installFetch((url) => {
      if (url.startsWith('/api/v1/search')) return searchResponse([projectResult], 'infra')
      if (url === '/api/v1/projects/proj-2') return projectBody('proj-2', 'viewer')
      return undefined
    })
    openPalette()
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'infra' } })
    await vi.waitFor(() => expect(screen.getByText(/12 secrets/i)).toBeTruthy(), {
      timeout: 2000,
    })
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    expect(screen.queryByText(/New secret in/)).toBeNull()
  })

  it('selecting a search result remembers it as a recent for the next open', async () => {
    installFetch((url) => {
      if (url.startsWith('/api/v1/search')) return searchResponse([projectResult], 'infra')
      if (url === '/api/v1/projects/proj-2') return projectBody('proj-2', 'member')
      return undefined
    })
    const view = openPalette()
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'infra' } })
    await fireEvent.click(await screen.findByText(/12 secrets/i, {}, { timeout: 2000 }))
    expect(gotoMock).toHaveBeenCalledWith('/projects/proj-2')
    view.unmount()
    openPalette()
    expect(await screen.findByText('Recent')).toBeTruthy()
    expect(await screen.findByText('Infra Core')).toBeTruthy()
  })

  it('a recent the server no longer lets the user open is neither shown nor revealed', async () => {
    addRecent('u1', { type: 'project', id: 'gone-1', name: 'Hidden Merger' })
    addRecent('u1', { type: 'project', id: 'ok-1', name: 'Still Mine' })
    installFetch((url) =>
      url === '/api/v1/projects/ok-1' ? projectBody('ok-1', 'owner') : undefined
    )
    openPalette()
    expect(await screen.findByText('Still Mine')).toBeTruthy()
    expect(screen.queryByText('Hidden Merger')).toBeNull()
  })

  it('a recent is re-checked on selection: access lost since it was shown drops it', async () => {
    addRecent('u1', { type: 'project', id: 'ok-1', name: 'Still Mine' })
    let revoked = false
    installFetch((url) => {
      if (url !== '/api/v1/projects/ok-1') return undefined
      return revoked
        ? json(403, { code: 'forbidden', message: 'no' })
        : projectBody('ok-1', 'owner')
    })
    openPalette()
    const row = await screen.findByText('Still Mine')
    revoked = true
    await fireEvent.click(row)
    expect(await screen.findByText('That item is no longer available.')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
    expect(screen.queryByText('Still Mine')).toBeNull()
  })

  it('a recent that cannot be checked (server error) fails closed', async () => {
    addRecent('u1', { type: 'project', id: 'flaky', name: 'Flaky' })
    let down = false
    installFetch((url) => {
      if (url !== '/api/v1/projects/flaky') return undefined
      return down ? json(500, { code: 'x', message: 'boom' }) : projectBody('flaky', 'owner')
    })
    openPalette()
    const row = await screen.findByText('Flaky')
    down = true
    await fireEvent.click(row)
    expect(await screen.findByText('Could not open that item. Try again.')).toBeTruthy()
    expect(gotoMock).not.toHaveBeenCalled()
  })

  it('recents are per user: another user never sees them', async () => {
    addRecent('u1', { type: 'project', id: 'ok-1', name: 'Still Mine' })
    mockedPage.data = { user: { orgRole: 'owner', userId: 'someone-else' } }
    installFetch((url) =>
      url === '/api/v1/projects/ok-1' ? projectBody('ok-1', 'owner') : undefined
    )
    openPalette()
    await screen.findByText('Create project')
    expect(screen.queryByText('Still Mine')).toBeNull()
  })
})
