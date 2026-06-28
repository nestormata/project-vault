import { browser } from '$app/environment'
import {
  EMPTY_PROJECT_DASHBOARD_PREVIEW,
  type ProjectDashboardPreview,
} from '@project-vault/shared'

export type PreviewProject = {
  id: 'preview'
  name: string
  description: string
  persisted: false
  dashboard: ProjectDashboardPreview
}

let previewProject = $state<PreviewProject | null>(null)

export function createPreviewProject(): PreviewProject {
  return {
    id: 'preview',
    name: 'Preview Project',
    description: 'A temporary preview of the project-centered dashboard.',
    persisted: false,
    dashboard: EMPTY_PROJECT_DASHBOARD_PREVIEW,
  }
}

export function getPreviewProject(isBrowser = browser) {
  if (!isBrowser) return null
  previewProject ??= createPreviewProject()
  return previewProject
}

export function resetPreviewProject(isBrowser = browser) {
  if (!isBrowser) return
  previewProject = null
}
