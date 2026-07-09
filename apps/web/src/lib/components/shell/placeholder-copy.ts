// Story 6.3 Task 8: 'health' removed — /health now renders the real cross-project health
// dashboard instead of a placeholder, so its old "arrives in Epic 6" copy no longer applies.
// Story 9.7 AC-T1: 'settings' removed — has zero live callers in apps/web/src/routes; keeping
// unreachable dead code is worse than removing it (retro Finding 7 / Action Item A9-4).
export type PlaceholderSectionKey = 'projects' | 'credentials'

export type PlaceholderSectionCopy = {
  title: string
  copy: string
}

const placeholderSections: Record<PlaceholderSectionKey, PlaceholderSectionCopy> = {
  projects: {
    title: 'Projects',
    copy: 'No projects are saved yet. Project persistence arrives in Story 2.1.',
  },
  credentials: {
    title: 'Credentials',
    copy: 'Choose a project to manage credentials.',
  },
}

export function getPlaceholderSections() {
  return placeholderSections
}

export function getPlaceholderSection(key: PlaceholderSectionKey) {
  switch (key) {
    case 'projects':
      return placeholderSections.projects
    case 'credentials':
      return placeholderSections.credentials
  }
}
