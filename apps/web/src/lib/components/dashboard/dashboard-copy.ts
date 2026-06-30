export const dashboardEmptyStateCopy = {
  projectModel:
    'Projects are the home for everything your product depends on: credentials, certificates, services, alerts, and operational context.',
  organizingPrinciple:
    'Project Vault organizes by project, not by environment. Add the things that keep one product running in one place.',
  previewAction: 'Preview an empty project dashboard',
  previewWarning: 'Preview only. Use Create project for saved project dashboards.',
  noProjects: 'No projects are saved yet.',
  noCredentials: 'No credentials added yet.',
  noCertificates: 'No certificate or domain records added yet.',
  noServices: 'No monitored services configured yet.',
  noAlerts: 'No alert sources configured yet.',
}

export const forbiddenDashboardClaims = ['All systems healthy', '0 alerts', '100% coverage']

export const suggestedActionLabels = {
  add_credential: 'Add first credential',
  add_service: 'Add first service - available in Epic 6',
  import_credentials: 'Import .env or JSON',
} as const
