import { describe, expect, it } from 'vitest'
import {
  dashboardEmptyStateCopy,
  forbiddenDashboardClaims,
  suggestedActionLabels,
} from '$lib/components/dashboard/dashboard-copy.js'

describe('dashboard empty state', () => {
  it('renders project-centric explanation and preview-only warning', () => {
    expect(dashboardEmptyStateCopy.projectModel).toContain('Projects are the home')
    expect(dashboardEmptyStateCopy.organizingPrinciple).toContain('organizes by project')
    expect(dashboardEmptyStateCopy.previewWarning).toBe(
      'Preview only. Use Create project for saved project dashboards.'
    )
  })

  it('does not allow fake healthy/success/count copy', () => {
    expect(forbiddenDashboardClaims).toEqual(
      expect.arrayContaining(['All systems healthy', '100% coverage'])
    )
    expect(JSON.stringify(dashboardEmptyStateCopy)).not.toContain('All systems healthy')
    expect(JSON.stringify(dashboardEmptyStateCopy)).not.toContain('100% coverage')
  })

  it('labels suggested actions as not yet available', () => {
    expect(suggestedActionLabels).toEqual({
      add_credential: 'Add first credential - available in Story 2.2',
      add_service: 'Add first service - available in Epic 6',
      import_credentials: 'Import .env or JSON - available in Story 2.5',
    })
  })
})
