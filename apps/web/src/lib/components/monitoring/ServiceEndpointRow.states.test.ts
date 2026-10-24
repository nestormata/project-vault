// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeIgnoringIndent } from '$lib/test/dom.js'

// Story 69.12: one service endpoint row in each state it can render (each status, paused, running,
// no pause flag, a caller who cannot manage). Recorded BEFORE the split into sub-regions; it must
// come out unchanged. Rows are mounted inside a table, as the endpoint table does.

process.env.TZ = 'America/Panama'

vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))

const endpoint = {
  id: 'e-1',
  orgId: 'o-1',
  projectId: 'p-1',
  name: 'Public API',
  url: 'https://api.example.test/health',
  checkFrequencyMinutes: 5,
  downThresholdFailures: 3,
  status: 'healthy',
  consecutiveFailures: 0,
  lastCheckedAt: '2026-10-20T10:00:00.000Z',
  healthCheckPaused: false,
  healthCheckPausedAt: null,
  healthCheckPausedBy: null,
  createdBy: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
}

const CASES: Record<
  string,
  { endpoint: Record<string, unknown>; canManage: boolean; extra?: object }
> = {
  'healthy-manage': { endpoint, canManage: true },
  'healthy-read-only': { endpoint, canManage: false },
  'degraded-never-checked': {
    endpoint: { ...endpoint, status: 'degraded', lastCheckedAt: null },
    canManage: true,
  },
  'down-paused': {
    endpoint: {
      ...endpoint,
      status: 'down',
      healthCheckPaused: true,
      healthCheckPausedAt: '2026-10-21T09:00:00.000Z',
    },
    canManage: true,
  },
  'no-pause-flag': {
    endpoint: { ...endpoint, healthCheckPaused: undefined },
    canManage: true,
  },
  'pause-error': {
    endpoint,
    canManage: true,
    extra: { pauseError: 'Could not pause.', pauseSubmitting: true },
  },
}

let Row: Component<Record<string, unknown>>
beforeAll(async () => {
  Row = (await import('./ServiceEndpointRow.svelte')).default as unknown as typeof Row
}, 60_000)
afterEach(cleanup)

const mountRow = (spec: (typeof CASES)[string]) => {
  const table = document.createElement('table')
  const body = document.createElement('tbody')
  table.append(body)
  document.body.append(table)
  const view = render(Row, {
    target: body,
    props: {
      project: { id: 'p-1', name: 'Project' },
      endpoint: spec.endpoint,
      orgRole: 'owner',
      projectId: 'p-1',
      canManage: spec.canManage,
      pauseSubmitting: false,
      pauseError: null,
      onPauseToggle: vi.fn(),
      onDelete: vi.fn(),
      ...spec.extra,
    },
  })
  return { view, table }
}

describe('ServiceEndpointRow states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: [string, string][] = []
    for (const [name, spec] of Object.entries(CASES)) {
      const { table } = mountRow(spec)
      states.push([name, serializeIgnoringIndent(table)])
      cleanup()
      table.remove()
    }
    await expect(`${JSON.stringify(Object.fromEntries(states), null, 2)}\n`).toMatchFileSnapshot(
      './ServiceEndpointRow.states.snapshot.json'
    )
  }, 60_000)
})
