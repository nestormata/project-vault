import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const updateStatusPageServicesMock = vi.hoisted(() => vi.fn())
const regenerateStatusPageTokenMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/status-page.js', () => ({
  disableStatusPage: vi.fn(),
  enableStatusPage: vi.fn(),
  regenerateStatusPageToken: regenerateStatusPageTokenMock,
  updateStatusPageServices: updateStatusPageServicesMock,
}))

import StatusPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function serviceEndpoint(id: string, name: string) {
  return {
    id,
    name,
    url: `https://${name}.example.com`,
    status: 'up' as const,
    lastCheckedAt: null,
  }
}

function data(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    origin: 'https://vault.example.com',
    canManage: true,
    config: { enabled: true, token: 'tok-1', services: [] },
    serviceEndpoints: [
      serviceEndpoint('svc-1', 'API'),
      serviceEndpoint('svc-2', 'Database'),
      serviceEndpoint('svc-3', 'Worker'),
    ],
    ...overrides,
  }
}

describe('status-page +page.svelte (Story 21.8: deduplicated Services section)', () => {
  it('renders exactly one list for the services section, with no separate reorder-only box', () => {
    render(StatusPage, {
      props: {
        data: data({
          config: {
            enabled: true,
            token: 'tok-1',
            services: [{ serviceId: 'svc-1', displayName: 'API' }],
          },
        }),
      },
    })

    expect(document.querySelectorAll('ol, ul')).toHaveLength(1)
    expect(screen.queryByText(/^public service order$/i)).toBeNull()
    expect(screen.queryByRole('list', { name: /^public service order$/i })).toBeNull()
  })

  it('toggling a checkbox on shows its display-name input, toggling off hides it', async () => {
    render(StatusPage, { props: { data: data() } })

    const checkbox = screen.getByRole('checkbox', { name: 'API' })
    expect(screen.queryByPlaceholderText('Public display name')).toBeNull()

    await fireEvent.click(checkbox)
    expect(screen.getAllByPlaceholderText('Public display name')).toHaveLength(1)

    await fireEvent.click(checkbox)
    expect(screen.queryByPlaceholderText('Public display name')).toBeNull()
  })

  it('reorder buttons move a selected service and are disabled at the array boundaries', async () => {
    updateStatusPageServicesMock.mockResolvedValue({
      services: [
        { serviceId: 'svc-2', displayName: 'Database' },
        { serviceId: 'svc-1', displayName: 'API' },
      ],
    })

    render(StatusPage, {
      props: {
        data: data({
          config: {
            enabled: true,
            token: 'tok-1',
            services: [
              { serviceId: 'svc-1', displayName: 'API' },
              { serviceId: 'svc-2', displayName: 'Database' },
            ],
          },
        }),
      },
    })

    const upButtons = screen.getAllByRole('button', { name: /move .* up/i })
    const downButtons = screen.getAllByRole('button', { name: /move .* down/i })

    // First row (API) is at the top boundary; last row (Database) is at the bottom boundary.
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true)
    expect((downButtons[downButtons.length - 1] as HTMLButtonElement).disabled).toBe(true)
    expect((downButtons[0] as HTMLButtonElement).disabled).toBe(false)
    expect((upButtons[upButtons.length - 1] as HTMLButtonElement).disabled).toBe(false)

    await fireEvent.click(downButtons[0] as HTMLButtonElement)

    await vi.waitFor(() =>
      expect(updateStatusPageServicesMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        expect.objectContaining({
          services: [
            { serviceId: 'svc-2', displayName: 'Database' },
            { serviceId: 'svc-1', displayName: 'API' },
          ],
        })
      )
    )
  })

  it("leaves a middle row's reorder buttons enabled when three or more services are selected", () => {
    render(StatusPage, {
      props: {
        data: data({
          config: {
            enabled: true,
            token: 'tok-1',
            services: [
              { serviceId: 'svc-1', displayName: 'API' },
              { serviceId: 'svc-2', displayName: 'Database' },
              { serviceId: 'svc-3', displayName: 'Worker' },
            ],
          },
        }),
      },
    })

    const upButtons = screen.getAllByRole('button', { name: /move .* up/i })
    const downButtons = screen.getAllByRole('button', { name: /move .* down/i })

    expect((upButtons[1] as HTMLButtonElement).disabled).toBe(false)
    expect((downButtons[1] as HTMLButtonElement).disabled).toBe(false)
  })

  it('reorder controls are absent entirely when only one service is selected', () => {
    render(StatusPage, {
      props: {
        data: data({
          config: {
            enabled: true,
            token: 'tok-1',
            services: [{ serviceId: 'svc-1', displayName: 'API' }],
          },
        }),
      },
    })

    expect(screen.queryByRole('button', { name: /move .* up/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /move .* down/i })).toBeNull()
  })

  it('renders selected services first (in selected order), then unselected services in their existing order', () => {
    render(StatusPage, {
      props: {
        data: data({
          config: {
            enabled: true,
            token: 'tok-1',
            // svc-3 selected before svc-1 — selected order should win over endpoint list order.
            services: [
              { serviceId: 'svc-3', displayName: 'Worker' },
              { serviceId: 'svc-1', displayName: 'API' },
            ],
          },
        }),
      },
    })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)

    const rowLabels = rows.map((row) => row.textContent ?? '')

    expect(rowLabels[0]).toContain('Worker')
    expect(rowLabels[1]).toContain('API')
    expect(rowLabels[2]).toContain('Database')
  })

  it('both FormHelpText instances render as children of their <li>, not as direct list siblings', async () => {
    render(StatusPage, {
      props: {
        data: data({
          config: {
            enabled: true,
            token: 'tok-1',
            services: [{ serviceId: 'svc-1', displayName: 'API' }],
          },
        }),
      },
    })

    const ol = document.querySelector('ol')
    expect(ol).not.toBeNull()

    // No direct <p> (FormHelpText's root element) siblings of <li> inside the list.
    for (const child of Array.from(ol?.children ?? [])) {
      expect(child.tagName).toBe('LI')
    }

    for (const li of Array.from(ol?.querySelectorAll('li') ?? [])) {
      const helpTexts = li.querySelectorAll('p')
      expect(helpTexts.length).toBeGreaterThanOrEqual(1)
      for (const p of Array.from(helpTexts)) {
        expect(li.contains(p)).toBe(true)
      }
    }

    // The selected row (with display-name input open) carries both help texts inside its <li>.
    const selectedLi = screen.getByRole('checkbox', { name: 'API' }).closest('li')
    expect(selectedLi).not.toBeNull()
    expect(selectedLi?.querySelectorAll('p').length).toBe(2)
  })
})

describe('status-page +page.svelte (Story 6.6: two-step rotation confirm and legacy-row copy)', () => {
  it('does not call regenerate on the first click of "Regenerate link", only after the relabeled confirm click', async () => {
    render(StatusPage, { props: { data: data() } })

    const button = screen.getByRole('button', { name: 'Regenerate link' })
    await fireEvent.click(button)

    expect(regenerateStatusPageTokenMock).not.toHaveBeenCalled()
    expect(screen.getByText(/\/status\/tok-1$/)).toBeTruthy()

    const confirmButton = screen.getByRole('button', { name: /confirm.*old link stops working/i })
    regenerateStatusPageTokenMock.mockResolvedValue({ token: 'tok-2' })
    await fireEvent.click(confirmButton)

    expect(regenerateStatusPageTokenMock).toHaveBeenCalledWith(expect.anything(), projectId)
  })

  it('renders the "cannot be reconstructed" migration copy for a legacy row, not the generic fallback', () => {
    render(StatusPage, {
      props: {
        data: data({
          config: { enabled: true, token: undefined, legacyToken: true, services: [] },
        }),
      },
    })

    expect(screen.getByText(/can't be redisplayed/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Migrate to persistent link' })).toBeTruthy()
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull()
  })

  it('legacy row: does not call regenerate on the first click of "Migrate to persistent link", only after the relabeled confirm click, and clears legacyToken once it resolves', async () => {
    render(StatusPage, {
      props: {
        data: data({
          config: { enabled: true, token: undefined, legacyToken: true, services: [] },
        }),
      },
    })

    const button = screen.getByRole('button', { name: 'Migrate to persistent link' })
    await fireEvent.click(button)

    expect(regenerateStatusPageTokenMock).not.toHaveBeenCalled()
    expect(screen.getByText(/can't be redisplayed/i)).toBeTruthy()

    const confirmButton = screen.getByRole('button', { name: /confirm.*old link stops working/i })
    regenerateStatusPageTokenMock.mockResolvedValue({ token: 'tok-migrated' })
    await fireEvent.click(confirmButton)

    expect(regenerateStatusPageTokenMock).toHaveBeenCalledWith(expect.anything(), projectId)
    expect(await screen.findByText(/tok-migrated$/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toBeTruthy()
    expect(screen.queryByText(/can't be redisplayed/i)).toBeNull()
  })

  it('renders the neutral temporarily-unavailable copy for a sealed/transient row, unchanged', () => {
    render(StatusPage, {
      props: {
        data: data({
          config: { enabled: true, token: undefined, legacyToken: false, services: [] },
        }),
      },
    })

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toBeTruthy()
    expect(screen.queryByText(/can't be redisplayed/i)).toBeNull()
  })
})
