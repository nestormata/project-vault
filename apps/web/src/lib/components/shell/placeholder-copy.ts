export type PlaceholderSectionKey = 'projects' | 'credentials' | 'health' | 'settings'

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
  health: {
    title: 'Health',
    copy: 'No monitored services configured yet. Service and endpoint monitoring arrives in Epic 6.',
  },
  settings: {
    title: 'Settings',
    copy: 'Settings are limited while the MVP shell is being assembled.',
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
    case 'health':
      return placeholderSections.health
    case 'settings':
      return placeholderSections.settings
  }
}
