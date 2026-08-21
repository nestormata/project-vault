export const dashboardEmptyStateCopy = {
  projectModel:
    'Projects are the home for everything your product depends on: secrets, certificates, services, alerts, and operational context.',
  organizingPrinciple:
    'Project Vault organizes by project, not by environment. Add the things that keep one product running in one place.',
  previewAction: 'Preview an empty project dashboard',
  previewWarning: 'Preview only. Use Create project for saved project dashboards.',
  noProjects: 'No projects are saved yet.',
  noCredentials: 'No secrets added yet.',
  noCertificates: 'No certificate or domain records added yet.',
  noServices: 'No monitored services configured yet.',
  noAlerts: 'No alert sources configured yet.',
}

export const forbiddenDashboardClaims = ['All systems healthy', '0 alerts', '100% coverage']

export const suggestedActionLabels = {
  add_credential: 'Add first secret',
  add_service: 'Add first service',
  import_credentials: 'Import .env or JSON',
} as const

// AC-A1: humanized labels for the "Recent activity" section — keys are the 8 real credential.*
// audit event types (packages/shared/src/constants/audit-events.ts / dashboard.ts's
// RecentAccessEventSchema).
export const recentAccessEventLabels = {
  'credential.created': 'Created',
  'credential.version_created': 'Added new version',
  'credential.value_revealed': 'Revealed value',
  'credential.version_purged': 'Purged old version',
  'credential.tags_updated': 'Updated tags',
  'credential.dependency_added': 'Added dependent system',
  'credential.dependency_archived': 'Archived dependent system',
  'credential.lifecycle_updated': 'Updated lifecycle settings',
} as const
