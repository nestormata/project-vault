import { describe, expect, it } from 'vitest'
import {
  EMPTY_PROJECT_DASHBOARD,
  EMPTY_PROJECT_DASHBOARD_PREVIEW,
  ProjectDashboardPreviewSchema,
  ProjectDashboardSchema,
} from './dashboard.js'

const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000001'}`
const CREDENTIAL_NAME = 'DB Password'
const OCCURRED_AT = '2026-07-01T00:00:00.000Z'

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
            credentialName: CREDENTIAL_NAME,
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
            credentialName: CREDENTIAL_NAME,
            actorDisplayName: 'Nestor',
            eventType: 'credential.value_revealed',
            occurredAt: OCCURRED_AT,
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

  // AC-A4: the eventType enum must match the 8 real credential.* audit event types that satisfy
  // AC-A1's `resource_type = 'credential'` filter — not the fabricated 'credential.updated'.
  it('AC-A4: accepts all 8 real credential.* event types', () => {
    const realEventTypes = [
      'credential.created',
      'credential.version_created',
      'credential.value_revealed',
      'credential.version_purged',
      'credential.tags_updated',
      'credential.dependency_added',
      'credential.dependency_archived',
      'credential.lifecycle_updated',
    ]
    for (const eventType of realEventTypes) {
      expect(() =>
        ProjectDashboardSchema.parse({
          ...EMPTY_PROJECT_DASHBOARD,
          recentAccessEvents: [
            {
              credentialId: CREDENTIAL_ID,
              credentialName: CREDENTIAL_NAME,
              actorDisplayName: 'Nestor',
              eventType,
              occurredAt: OCCURRED_AT,
            },
          ],
        })
      ).not.toThrow()
    }
  })

  it('AC-A4 regression: rejects the fabricated "credential.updated" event type', () => {
    expect(() =>
      ProjectDashboardSchema.parse({
        ...EMPTY_PROJECT_DASHBOARD,
        recentAccessEvents: [
          {
            credentialId: CREDENTIAL_ID,
            credentialName: CREDENTIAL_NAME,
            actorDisplayName: 'Nestor',
            eventType: 'credential.updated',
            occurredAt: OCCURRED_AT,
          },
        ],
      })
    ).toThrow()
  })
})
