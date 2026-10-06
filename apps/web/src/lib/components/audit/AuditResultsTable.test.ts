import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AuditResultsTable from './AuditResultsTable.svelte'
import type { AuditEventItem } from '$lib/api/audit.js'

afterEach(() => cleanup())

const USER_ID = '33333333-3333-4333-8333-333333333333'
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'

function event(overrides: Partial<AuditEventItem>): AuditEventItem {
  return {
    id: 'e1',
    eventType: 'project.import_failed',
    actorDisplayName: 'Alice',
    resourceType: 'project_import',
    resourceId: null,
    projectId: null,
    ipAddress: null,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  } as AuditEventItem
}

const SHAPES: [string, AuditEventItem][] = [
  ['import_failed', event({ id: 'e1' })],
  [
    'export_created',
    event({
      id: 'e2',
      eventType: 'project.export_created',
      resourceType: 'project',
      resourceId: PROJECT_ID,
      projectId: PROJECT_ID,
    }),
  ],
  [
    'import_completed',
    event({
      id: 'e3',
      eventType: 'project.import_completed',
      resourceType: 'project',
      resourceId: PROJECT_ID,
      projectId: PROJECT_ID,
    }),
  ],
]

function renderTable(events: AuditEventItem[]) {
  return render(AuditResultsTable, {
    props: {
      events,
      filters: undefined,
      hasFilters: false,
      page: 1,
      total: events.length,
      hasNext: false,
    },
  })
}

describe('AuditResultsTable resource rendering (Story 62-1 AC-3)', () => {
  it.each(SHAPES)('%s row renders no resource-derived link', async (_name, item) => {
    const { container } = renderTable([item])
    await fireEvent.click(screen.getAllByRole('row')[1] as HTMLElement)

    const hrefs = Array.from(container.querySelectorAll('a[href]')).map((a) =>
      a.getAttribute('href')
    )
    expect(hrefs.some((h) => h?.includes('/projects/'))).toBe(false)
    expect(hrefs.some((h) => h?.includes(USER_ID))).toBe(false)
  })

  it('import_failed row shows the project_import type and placeholders for empty ids', async () => {
    renderTable([event({ id: 'e1' })])
    await fireEvent.click(screen.getAllByRole('row')[1] as HTMLElement)

    expect(screen.getAllByText('project_import').length).toBeGreaterThan(0)
    // table Project + IP cells, expanded Resource ID + Project + IP
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5)
  })
})

describe('AuditResultsTable issuer-attested actors (Story 71-10 AC-4)', () => {
  const ATTESTED = {
    actor: {
      kind: 'issuer_attested' as const,
      provider: 'workos',
      subject: 'Nestor Mata',
      reason: 'unlinked' as const,
    },
  }

  function attributed(id: string, attribution: AuditEventItem['attribution']): AuditEventItem {
    return event({
      id,
      eventType: 'ext.com.acme.thing',
      actorDisplayName: 'extension',
      attribution,
    })
  }

  it('shows a text badge, provider, subject and the reason in words; the actor name stays "extension"', () => {
    const { container } = renderTable([attributed('a1', ATTESTED)])
    const marker = container.querySelector('[data-testid="actor-attestation"]') as HTMLElement
    expect(marker).not.toBeNull()
    expect(marker.textContent).toContain('Attested by issuer')
    expect(marker.textContent).toContain('workos')
    expect(marker.textContent).toContain('Nestor Mata')
    expect(marker.textContent).toContain('no PV account')
    const actorCell = screen.getByText('extension')
    expect(actorCell.tagName).toBe('TD')
    expect(actorCell.contains(marker)).toBe(true)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('states "no longer a member" for not_current_member', () => {
    renderTable([
      attributed('a2', {
        actor: { ...ATTESTED.actor, reason: 'not_current_member' },
      }),
    ])
    expect(screen.getByText(/no longer a member/)).toBeTruthy()
  })

  it('shows the quieter delegated line, and no issuer badge, for a pv_verified delegated row', () => {
    renderTable([
      attributed('a3', {
        actor: { kind: 'pv_verified', provider: 'workos', subject: 'user_9', reason: null },
      }),
    ])
    expect(screen.getByText('Verified by PV, delegated by service')).toBeTruthy()
    expect(screen.queryByText('Attested by issuer')).toBeNull()
  })

  it('renders a row without attribution with only the actor name in its actor cell', () => {
    const { container } = renderTable([event({ id: 'p1' })])
    expect(container.querySelector('[data-testid="actor-attestation"]')).toBeNull()
    const cell = screen.getByText('Alice')
    expect(cell.tagName).toBe('TD')
    expect(cell.children).toHaveLength(0)
    expect(container.textContent).not.toMatch(/Attested by issuer|Verified by PV/)
  })

  it.each([
    ['an img tag', '<img src=x onerror=alert(1)>'],
    ['a closing code tag and bold', '</code><b>x</b>'],
  ])('renders hostile %s as inert text', (_n, subject) => {
    const { container } = renderTable([
      attributed('h1', { actor: { ...ATTESTED.actor, provider: 'p', subject } }),
    ])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain(subject)
  })

  it('wraps a 256-character unbroken subject instead of widening the page', () => {
    const subject = 'x'.repeat(256)
    const { container } = renderTable([attributed('h2', { actor: { ...ATTESTED.actor, subject } })])
    const marker = container.querySelector('[data-testid="actor-attestation"]') as HTMLElement
    expect(marker.textContent).toContain(subject)
    expect(marker.className).toMatch(/break-all|\[overflow-wrap:anywhere\]/)
  })

  it('shows occurrence time only when it differs from createdAt by more than one second', () => {
    const base = '2026-10-05T00:00:00.000Z'
    const { container, unmount } = renderTable([
      attributed('t1', {
        ...ATTESTED,
        occurredAt: '2026-10-04T23:00:00.000Z',
        occurredAtSource: 'delegation_signed',
      }),
    ])
    expect(container.textContent).toMatch(/Occurred .* \(issuer-attested\)/)
    unmount()
    const declared = renderTable([
      attributed('t2', {
        ...ATTESTED,
        occurredAt: '2026-10-04T23:00:00.000Z',
        occurredAtSource: 'extension',
      }),
    ])
    expect(declared.container.textContent).toMatch(/Occurred .* \(declared by extension\)/)
    declared.unmount()
    const close = renderTable([
      attributed('t3', {
        ...ATTESTED,
        occurredAt: new Date(Date.parse(base) - 500).toISOString(),
        occurredAtSource: 'delegation_signed',
      }),
    ])
    expect(close.container.textContent).not.toContain('Occurred')
  })
})
