import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const enableStatusPageMock = vi.hoisted(() => vi.fn())
const regenerateStatusPageTokenMock = vi.hoisted(() => vi.fn())
const disableStatusPageMock = vi.hoisted(() => vi.fn())
const updateStatusPageServicesMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/status-page.js', () => ({
  enableStatusPage: enableStatusPageMock,
  regenerateStatusPageToken: regenerateStatusPageTokenMock,
  disableStatusPage: disableStatusPageMock,
  updateStatusPageServices: updateStatusPageServicesMock,
}))

import StatusPageAdminPage from './(app)/projects/[projectId]/status-page/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const endpoints = [
  {
    id: 'endpoint-1',
    projectId,
    name: 'API',
    url: 'https://api.example.com/health',
    method: 'GET',
    intervalSeconds: 60,
    timeoutSeconds: 10,
    expectedStatusCodes: [200],
    status: 'up',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 'endpoint-2',
    projectId,
    name: 'Web',
    url: 'https://example.com',
    method: 'GET',
    intervalSeconds: 60,
    timeoutSeconds: 10,
    expectedStatusCodes: [200],
    status: 'up',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
]

function pageData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    canManage: true,
    config: { enabled: true, token: null, services: [] },
    serviceEndpoints: endpoints,
    ...overrides,
  }
}

describe('/projects/:projectId/status-page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    })
  })

  afterEach(() => cleanup())

  it('links to the new service-endpoints registration page when zero endpoints exist', () => {
    render(StatusPageAdminPage, {
      props: { data: pageData({ serviceEndpoints: [] }) },
    })

    const link = screen.getByRole('link', { name: /register one/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/service-endpoints`)
  })

  it('renders an honest read-only state without management controls', () => {
    render(StatusPageAdminPage, { props: { data: pageData({ canManage: false }) } })

    expect(screen.getByText(/only the project owner or an org owner/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('enables once while busy, shows the one-time URL, and copies the exact URL', async () => {
    let resolveEnable!: (value: { token: string }) => void
    enableStatusPageMock.mockReturnValue(
      new Promise<{ token: string }>((resolve) => {
        resolveEnable = resolve
      })
    )
    render(StatusPageAdminPage, {
      props: { data: pageData({ config: { enabled: false, token: null, services: [] } }) },
    })

    const enable = screen.getByRole('button', { name: /enable public status page/i })
    await fireEvent.click(enable)
    await fireEvent.click(enable)
    expect(enableStatusPageMock).toHaveBeenCalledTimes(1)
    expect((enable as HTMLButtonElement).disabled).toBe(true)

    resolveEnable({ token: 'one-time-token' })
    expect(await screen.findByText(`${window.location.origin}/status/one-time-token`)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/status/one-time-token`
    )
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy()
  })

  it.each([
    [
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required'),
      /enable mfa to manage/i,
    ],
    [new Error('enable exploded'), /enable exploded/i],
    [42, /failed to enable the status page/i],
  ])('maps enable failures without exposing a URL', async (failure, expected) => {
    enableStatusPageMock.mockRejectedValue(failure)
    render(StatusPageAdminPage, {
      props: { data: pageData({ config: { enabled: false, token: null, services: [] } }) },
    })

    await fireEvent.click(screen.getByRole('button', { name: /enable public status page/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('regenerates once while busy and replaces the one-time URL', async () => {
    let resolveRegenerate!: (value: { token: string }) => void
    regenerateStatusPageTokenMock.mockReturnValue(
      new Promise<{ token: string }>((resolve) => {
        resolveRegenerate = resolve
      })
    )
    render(StatusPageAdminPage, { props: { data: pageData() } })

    const regenerate = screen.getByRole('button', { name: /regenerate link/i })
    await fireEvent.click(regenerate)
    await fireEvent.click(regenerate)
    expect(regenerateStatusPageTokenMock).toHaveBeenCalledTimes(1)
    resolveRegenerate({ token: 'replacement' })
    expect(await screen.findByText(`${window.location.origin}/status/replacement`)).toBeTruthy()
  })

  it.each([
    [
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required'),
      /enable mfa to manage/i,
    ],
    [new Error('regenerate exploded'), /regenerate exploded/i],
    [{ reason: 'unknown' }, /failed to regenerate the token/i],
  ])('maps regenerate failures', async (failure, expected) => {
    regenerateStatusPageTokenMock.mockRejectedValue(failure)
    render(StatusPageAdminPage, { props: { data: pageData() } })
    await fireEvent.click(screen.getByRole('button', { name: /regenerate link/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })

  it('disables once while busy and returns to the disabled state', async () => {
    let resolveDisable!: () => void
    disableStatusPageMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDisable = resolve
      })
    )
    render(StatusPageAdminPage, { props: { data: pageData() } })

    const disable = screen.getByRole('button', { name: /^disable$/i })
    await fireEvent.click(disable)
    await fireEvent.click(disable)
    expect(disableStatusPageMock).toHaveBeenCalledTimes(1)
    resolveDisable()
    expect(await screen.findByText(/no public status page has been created/i)).toBeTruthy()
  })

  it.each([
    [new Error('disable exploded'), /disable exploded/i],
    [null, /failed to disable the status page/i],
  ])('maps disable failures and keeps the page enabled', async (failure, expected) => {
    disableStatusPageMock.mockRejectedValue(failure)
    render(StatusPageAdminPage, { props: { data: pageData() } })
    await fireEvent.click(screen.getByRole('button', { name: /^disable$/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    expect(screen.getByRole('button', { name: /regenerate link/i })).toBeTruthy()
  })

  it('selects, edits, saves, and deselects endpoint display names', async () => {
    updateStatusPageServicesMock.mockImplementation(
      async (_fetch: unknown, _projectId: string, body: { services: unknown[] }) => body
    )
    render(StatusPageAdminPage, { props: { data: pageData() } })

    const apiCheckbox = screen.getByRole('checkbox', { name: /api/i })
    await fireEvent.click(apiCheckbox)
    const displayName = screen.getByPlaceholderText(/public display name/i)
    await fireEvent.input(displayName, { target: { value: 'Public API' } })
    await fireEvent.click(screen.getByRole('button', { name: /save services/i }))
    expect(updateStatusPageServicesMock).toHaveBeenLastCalledWith(expect.anything(), projectId, {
      services: [{ serviceId: 'endpoint-1', displayName: 'Public API' }],
    })

    await fireEvent.click(apiCheckbox)
    await fireEvent.click(screen.getByRole('button', { name: /save services/i }))
    expect(updateStatusPageServicesMock).toHaveBeenLastCalledWith(expect.anything(), projectId, {
      services: [],
    })
  })

  it.each([
    [
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required'),
      /enable mfa to manage/i,
    ],
    [new Error('save exploded'), /save exploded/i],
    [undefined, /failed to save services/i],
  ])('maps service-save failures', async (failure, expected) => {
    updateStatusPageServicesMock.mockRejectedValue(failure)
    render(StatusPageAdminPage, { props: { data: pageData() } })
    await fireEvent.click(screen.getByRole('button', { name: /save services/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
  })
})
