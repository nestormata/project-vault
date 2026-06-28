import { describe, expect, it } from 'vitest'
import { EMPTY_PROJECT_DASHBOARD_PREVIEW, ProjectDashboardPreviewSchema } from './dashboard.js'

describe('project dashboard preview schema', () => {
  it('accepts the canonical empty preview dashboard', () => {
    expect(ProjectDashboardPreviewSchema.parse(EMPTY_PROJECT_DASHBOARD_PREVIEW)).toEqual(
      EMPTY_PROJECT_DASHBOARD_PREVIEW
    )
  })

  it('rejects non-empty rotations and access events for the 2.0 preview invariant', () => {
    expect(() =>
      ProjectDashboardPreviewSchema.parse({
        ...EMPTY_PROJECT_DASHBOARD_PREVIEW,
        upcomingRotations: [{ id: 'rotation-1' }],
      })
    ).toThrow()
    expect(() =>
      ProjectDashboardPreviewSchema.parse({
        ...EMPTY_PROJECT_DASHBOARD_PREVIEW,
        recentAccessEvents: [{ id: 'event-1' }],
      })
    ).toThrow()
  })
})
