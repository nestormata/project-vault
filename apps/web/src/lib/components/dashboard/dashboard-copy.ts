import { m } from '$lib/paraglide/messages.js'

// Story 28.4 AC1/Task 3: these are functions, not module-level literals, so every value resolves
// via m.dashboard_*() at the point of use (inside a Svelte template expression) rather than being
// baked in once at module-load time — the same "resolved once vs. resolved at read time" hazard
// AC2 fixes for the nav bar applies here too, since Svelte 5 reactively re-evaluates a function
// call read directly inside a template on every re-render (including after a no-reload locale
// switch), but would NOT re-evaluate a plain object built once at import time.
export function getDashboardEmptyStateCopy() {
  return {
    projectModel: m.dashboard_project_model(),
    organizingPrinciple: m.dashboard_organizing_principle(),
    previewAction: m.dashboard_preview_action(),
    previewWarning: m.dashboard_preview_warning(),
    noProjects: m.dashboard_no_projects(),
    noCredentials: m.dashboard_no_credentials(),
    noCertificates: m.dashboard_no_certificates(),
    noServices: m.dashboard_no_services(),
    noAlerts: m.dashboard_no_alerts(),
  }
}

export const forbiddenDashboardClaims = ['All systems healthy', '0 alerts', '100% coverage']

export type SuggestedAction = 'add_credential' | 'add_service' | 'import_credentials'

export function getSuggestedActionLabels(): Record<SuggestedAction, string> {
  return {
    add_credential: m.dashboard_suggested_add_credential(),
    add_service: m.dashboard_suggested_add_service(),
    import_credentials: m.dashboard_suggested_import_credentials(),
  }
}

// AC-A1: humanized labels for the "Recent activity" section — keys are the 8 real credential.*
// audit event types (packages/shared/src/constants/audit-events.ts / dashboard.ts's
// RecentAccessEventSchema).
export type RecentAccessEventType =
  | 'credential.created'
  | 'credential.version_created'
  | 'credential.value_revealed'
  | 'credential.version_purged'
  | 'credential.tags_updated'
  | 'credential.dependency_added'
  | 'credential.dependency_archived'
  | 'credential.lifecycle_updated'

export function getRecentAccessEventLabels(): Record<RecentAccessEventType, string> {
  return {
    'credential.created': m.dashboard_event_created(),
    'credential.version_created': m.dashboard_event_version_created(),
    'credential.value_revealed': m.dashboard_event_value_revealed(),
    'credential.version_purged': m.dashboard_event_version_purged(),
    'credential.tags_updated': m.dashboard_event_tags_updated(),
    'credential.dependency_added': m.dashboard_event_dependency_added(),
    'credential.dependency_archived': m.dashboard_event_dependency_archived(),
    'credential.lifecycle_updated': m.dashboard_event_lifecycle_updated(),
  }
}
