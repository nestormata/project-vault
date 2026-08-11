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
    origin: 'https://vault.example.com',
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
    // Story 18.2 AC-1/AC-2/AC-7: absolute URL built from data.origin (the request's resolved
    // origin), not an ad hoc window.location.origin read — proves it isn't just happening to
    // match jsdom's default location.
    expect(await screen.findByText('https://vault.example.com/status/one-time-token')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://vault.example.com/status/one-time-token'
    )
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy()
  })

  // Story 21.7: config.token (from the GET response) renders the same persistent link+Copy
  // panel as freshToken, with no "shown once" warning — this is the redisplay case, not the
  // ephemeral post-enable/regenerate one.
  it('renders a persistent link from data.config.token with no "shown once" warning', () => {
    render(StatusPageAdminPage, {
      props: {
        data: pageData({ config: { enabled: true, token: 'persisted-token', services: [] } }),
      },
    })

    expect(screen.getByText('https://vault.example.com/status/persisted-token')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeTruthy()
    expect(screen.queryByText(/shown once/i)).toBeNull()
    expect(screen.queryByText(/cannot be shown again/i)).toBeNull()
  })

  // Story 21.7 LEGACY_ROW / VAULT_SEALED_ON_READ: enabled with no token available at all (legacy
  // row predating the migration, or a sealed vault at read time) — an honest fallback, not an
  // implied error.
  it('shows an honest fallback when enabled but no token is available (legacy row / sealed vault)', () => {
    render(StatusPageAdminPage, {
      props: { data: pageData({ config: { enabled: true, token: null, services: [] } }) },
    })

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
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

  // Story 18.1 AC-2: an MFA-required failure must render a real link to /settings/security,
  // not just plain text telling the user to go enroll.
  it('renders an "Enable MFA" link (not just text) when enabling fails with mfa_required', async () => {
    enableStatusPageMock.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required', message: 'MFA required' }, 'MFA required')
    )
    render(StatusPageAdminPage, {
      props: { data: pageData({ config: { enabled: false, token: null, services: [] } }) },
    })

    await fireEvent.click(screen.getByRole('button', { name: /enable public status page/i }))
    const link = await screen.findByRole('link', { name: /enable mfa/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
  })

  // Story 6.6 AC-3/AC-6: rotation now needs an explicit two-step confirm (reused
  // ConfirmDeleteButton pattern) — the first click only relabels the button, the API call fires
  // only on the second, post-relabel click.
  it('requires a second, relabeled click to regenerate, and replaces the one-time URL', async () => {
    let resolveRegenerate!: (value: { token: string }) => void
    regenerateStatusPageTokenMock.mockReturnValue(
      new Promise<{ token: string }>((resolve) => {
        resolveRegenerate = resolve
      })
    )
    render(StatusPageAdminPage, { props: { data: pageData() } })

    const regenerate = screen.getByRole('button', { name: /^regenerate link$/i })
    await fireEvent.click(regenerate)
    expect(regenerateStatusPageTokenMock).not.toHaveBeenCalled()

    const confirm = screen.getByRole('button', { name: /confirm.*old link stops working/i })
    await fireEvent.click(confirm)
    await fireEvent.click(confirm)
    expect(regenerateStatusPageTokenMock).toHaveBeenCalledTimes(1)
    resolveRegenerate({ token: 'replacement' })
    expect(await screen.findByText('https://vault.example.com/status/replacement')).toBeTruthy()
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
    await fireEvent.click(screen.getByRole('button', { name: /^regenerate link$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm.*old link stops working/i }))
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

  it('reorders selected services with keyboard-operable controls and persists the new order', async () => {
    updateStatusPageServicesMock.mockResolvedValue({
      services: [
        { serviceId: 'endpoint-2', displayName: 'Web', sortOrder: 0 },
        { serviceId: 'endpoint-1', displayName: 'API', sortOrder: 1 },
      ],
    })
    render(StatusPageAdminPage, {
      props: {
        data: pageData({
          config: {
            enabled: true,
            token: null,
            services: [
              { serviceId: 'endpoint-1', displayName: 'API', sortOrder: 0 },
              { serviceId: 'endpoint-2', displayName: 'Web', sortOrder: 1 },
            ],
          },
        }),
      },
    })

    // Story 21.8: the reorder-only box was merged into the single services `<ol>` — assert on
    // that list's row order instead of the removed "Public service order" list.
    const serviceList = () =>
      screen.getByRole('list', { name: /services shown on the public page/i })
    expect(serviceList().querySelectorAll('li')[0]?.textContent).toContain('API')
    await fireEvent.click(screen.getByRole('button', { name: /move web up/i }))

    expect(updateStatusPageServicesMock).toHaveBeenLastCalledWith(expect.anything(), projectId, {
      services: [
        { serviceId: 'endpoint-2', displayName: 'Web' },
        { serviceId: 'endpoint-1', displayName: 'API' },
      ],
    })
    expect(serviceList().querySelectorAll('li')[0]?.textContent).toContain('Web')
  })

  it('reverts an optimistic reorder when persistence fails and surfaces the error', async () => {
    let rejectReorder!: (reason?: unknown) => void
    updateStatusPageServicesMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectReorder = reject
      })
    )
    render(StatusPageAdminPage, {
      props: {
        data: pageData({
          config: {
            enabled: true,
            token: null,
            services: [
              { serviceId: 'endpoint-1', displayName: 'API', sortOrder: 0 },
              { serviceId: 'endpoint-2', displayName: 'Web', sortOrder: 1 },
            ],
          },
        }),
      },
    })

    const serviceList = () =>
      screen.getByRole('list', { name: /services shown on the public page/i })
    await fireEvent.click(screen.getByRole('button', { name: /move web up/i }))
    expect(serviceList().querySelectorAll('li')[0]?.textContent).toContain('Web')

    rejectReorder(new Error('reorder failed'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/reorder failed/i)
    expect(serviceList().querySelectorAll('li')[0]?.textContent).toContain('API')
  })

  it('does not render reorder controls when one or fewer services are selected', () => {
    render(StatusPageAdminPage, {
      props: {
        data: pageData({
          config: {
            enabled: true,
            token: null,
            services: [{ serviceId: 'endpoint-1', displayName: 'API', sortOrder: 0 }],
          },
        }),
      },
    })

    expect(screen.queryByRole('button', { name: /move .* (up|down)/i })).toBeNull()
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
