import { describe, expect, it } from 'vitest'
import { EMPTY_PROJECT_DASHBOARD_PREVIEW } from '@project-vault/shared'
import {
  createPreviewProject,
  getPreviewProject,
  resetPreviewProject,
} from './preview-project.svelte.js'

describe('preview project state', () => {
  it('uses ProjectDashboardPreview from @project-vault/shared and is not persisted', () => {
    const project = createPreviewProject()

    expect(project).toEqual({
      id: 'preview',
      name: 'Preview Project',
      description: 'A temporary preview of the project-centered dashboard.',
      persisted: false,
      dashboard: EMPTY_PROJECT_DASHBOARD_PREVIEW,
    })
  })

  it('reset clears browser preview state', () => {
    const first = getPreviewProject(true)
    resetPreviewProject(true)
    const second = getPreviewProject(true)

    expect(first).not.toBe(second)
    expect(second?.persisted).toBe(false)
  })

  it('does not mutate preview state during SSR', () => {
    resetPreviewProject(true)

    expect(getPreviewProject(false)).toBeNull()
    expect(getPreviewProject(true)).toEqual(createPreviewProject())
  })
})
