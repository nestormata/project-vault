import { describe, expect, it } from 'vitest'
import type { load } from './+page.server.js'

// A CM-owned test of the REPLACEMENT's server-load contract, typed against the override. PV's own
// dashboard load test is excluded from the composed run (its subject was replaced); this one is not,
// so svelte-check must keep checking it.
type DashboardData = Exclude<Awaited<ReturnType<typeof load>>, void>

const describeContract = (data: DashboardData): string =>
  `${data.mockDashboard}:${String(data.mockUserId)}:${String(data.mockOrgName)}`

describe('mock dashboard override load contract', () => {
  it('names the three fields the pack page reads', () => {
    const sample = {
      mockDashboard: 'mock-ui-pack:m1-dashboard-load',
      mockUserId: null,
      mockOrgName: null,
    } satisfies DashboardData
    expect(describeContract(sample)).toBe('mock-ui-pack:m1-dashboard-load:null:null')
  })
})
