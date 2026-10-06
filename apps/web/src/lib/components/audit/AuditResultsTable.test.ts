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
