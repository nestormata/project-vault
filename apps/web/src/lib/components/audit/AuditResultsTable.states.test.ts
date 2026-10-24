// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the results table's states (empty with and without filters, attribution variants,
// the expanded detail row, pagination with filters). This pins them: the snapshot was recorded
// BEFORE the table was split into sub-regions and must come out unchanged.

process.env.TZ = 'America/Panama'

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

const POINT_PROPS = { orgRole: 'owner', allowed: true }

let Table: Component<Record<string, unknown>>
beforeAll(async () => {
  Table = (await import('./AuditResultsTable.svelte')).default as unknown as typeof Table
}, 60_000)
afterEach(cleanup)

const EVENTS = [
  {
    id: 'evt-a',
    eventType: 'credential.access',
    actorDisplayName: 'Dana Smith',
    resourceId: 'cred-1',
    resourceType: 'credential',
    projectId: 'proj-1',
    ipAddress: '203.0.113.4',
    createdAt: '2026-10-01T10:00:00.000Z',
    attribution: {
      actor: {
        kind: 'issuer_attested',
        provider: 'cm',
        subject: 'user-1',
        reason: 'not_current_member',
      },
      occurredAt: '2026-10-01T09:00:00.000Z',
      occurredAtSource: 'delegation_signed',
    },
  },
  {
    id: 'evt-b',
    eventType: 'member.invited',
    actorDisplayName: 'Olivia Owner',
    resourceId: null,
    resourceType: null,
    projectId: null,
    ipAddress: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    attribution: {
      actor: { kind: 'issuer_attested', provider: 'cm', subject: 'user-2', reason: 'unlinked' },
      occurredAt: '2026-10-01T08:00:00.000Z',
      occurredAtSource: 'extension',
    },
  },
  {
    id: 'evt-c',
    eventType: 'credential.rotated',
    actorDisplayName: 'Adam Admin',
    resourceId: 'cred-2',
    resourceType: 'credential',
    projectId: 'proj-2',
    ipAddress: '198.51.100.7',
    createdAt: '2026-10-01T08:00:00.000Z',
    attribution: {
      actor: { kind: 'pv_verified', provider: 'cm', subject: 'user-3', reason: null },
      occurredAt: '2026-10-01T08:00:00.500Z',
    },
  },
  {
    id: 'evt-d',
    eventType: 'project.import_failed',
    actorDisplayName: 'Eve Editor',
    resourceId: null,
    resourceType: 'project_import',
    projectId: null,
    ipAddress: null,
    createdAt: '2026-10-01T07:00:00.000Z',
    attribution: {},
  },
]
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const mount = (overrides: Record<string, unknown> = {}) =>
  render(Table, {
    props: {
      events: EVENTS,
      filters: undefined,
      hasFilters: false,
      page: 1,
      total: 4,
      hasNext: false,
      pointProps: POINT_PROPS,
      ...overrides,
    },
  })
const rows = () => screen.getAllByRole('row')

describe('AuditResultsTable states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const plain = mount()
    states['rows'] = serializeWithoutNoise(plain.container)
    await fireEvent.click(rows()[1] as HTMLElement)
    states['first-expanded'] = serializeWithoutNoise(plain.container)
    await fireEvent.click(rows()[3] as HTMLElement)
    states['second-expanded-first-collapsed'] = serializeWithoutNoise(plain.container)
    await fireEvent.click(rows()[2] as HTMLElement)
    states['collapsed-again'] = serializeWithoutNoise(plain.container)
    await fireEvent.click(rows()[4] as HTMLElement)
    states['bare-row-expanded'] = serializeWithoutNoise(plain.container)
    cleanup()

    const paged = mount({
      filters: { eventType: 'credential.access', actorProvider: 'cm', from: '2026-10-01' },
      hasFilters: true,
      page: 2,
      total: 45,
      hasNext: true,
    })
    states['paged-filtered'] = serializeWithoutNoise(paged.container)
    cleanup()

    const emptyPlain = mount({ events: [], total: 0 })
    states['empty'] = serializeWithoutNoise(emptyPlain.container)
    cleanup()

    const emptyFiltered = mount({ events: [], total: 0, hasFilters: true })
    states['empty-filtered'] = serializeWithoutNoise(emptyFiltered.container)

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './AuditResultsTable.states.snapshot.json'
    )
    expect(Object.keys(states)).toHaveLength(8)
  }, 60_000)
})
