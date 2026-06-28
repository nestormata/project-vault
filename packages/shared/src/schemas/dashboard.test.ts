import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROJECT_DASHBOARD,
  EMPTY_PROJECT_DASHBOARD_PREVIEW,
  ProjectDashboardPreviewSchema,
  ProjectDashboardSchema,
} from './dashboard.js'

const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000001'}`

describe('project dashboard preview schema', () => {
  it('accepts the canonical empty preview dashboard', () => {
    expect(ProjectDashboardPreviewSchema.parse(EMPTY_PROJECT_DASHBOARD_PREVIEW)).toEqual(
      EMPTY_PROJECT_DASHBOARD_PREVIEW
    )
  })

  it('parses EMPTY_PROJECT_DASHBOARD', () => {
    expect(ProjectDashboardSchema.parse(EMPTY_PROJECT_DASHBOARD)).toEqual(EMPTY_PROJECT_DASHBOARD)
  })

  it('accepts a valid upcoming rotation item', () => {
    expect(() =>
      ProjectDashboardSchema.parse({
        ...EMPTY_PROJECT_DASHBOARD,
        upcomingRotations: [
          {
            credentialId: CREDENTIAL_ID,
            credentialName: 'DB Password',
            scheduledAt: '2026-07-01T00:00:00.000Z',
            status: 'pending',
          },
        ],
        isEmpty: false,
      })
    ).not.toThrow()
  })

  it('accepts a valid recent access event item', () => {
    expect(() =>
      ProjectDashboardSchema.parse({
        ...EMPTY_PROJECT_DASHBOARD,
        recentAccessEvents: [
          {
            credentialId: CREDENTIAL_ID,
            credentialName: 'DB Password',
            actorDisplayName: 'Nestor',
            eventType: 'credential.value_revealed',
            occurredAt: '2026-07-01T00:00:00.000Z',
          },
        ],
        isEmpty: false,
      })
    ).not.toThrow()
  })

  it('rejects an upcoming rotation item missing required fields', () => {
    expect(() =>
      ProjectDashboardSchema.parse({
        ...EMPTY_PROJECT_DASHBOARD,
        upcomingRotations: [{ credentialName: 'only-name' }],
      })
    ).toThrow()
  })
})
