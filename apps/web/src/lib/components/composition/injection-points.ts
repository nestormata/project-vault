// Story 68.4 AC-2: the typed registry of injection points, the single source of point names.
// `InjectionPointProps` is what a contribution component receives for each point (Q6: the route id
// and params, plus the page's already-loaded primary entity where it has one). `INJECTION_POINTS` is
// the runtime table. `pnpm pack:web-host` joins it with the route files that render each point and
// ships `manifests/injection-points.json` (names, files, route ids, scopes). Names follow
// `<area>.<page>.<region>[.<position>]` (lowercase, dot-separated; `shell.<region>` has two
// segments). Adding a point is a PV change: add it here and render it with a literal name.
import type { Component } from 'svelte'
import type { getCredential } from '$lib/api/credentials.js'
import type { CapabilityMap } from '$lib/api/capabilities.js'
import type { getProject } from '$lib/api/projects.js'
import type { ProjectSummary, PublicStatusPage } from '@project-vault/shared'
import type { OrgRole } from '$lib/credentials/permissions.js'
import type { AuthUser } from '$lib/api/auth.js'
import type { AuditEventItem } from '$lib/api/audit.js'
import type { PreferenceItem, RoutingItem } from '$lib/api/notifications.js'
import type { ProjectInvitation } from '$lib/api/invitations.js'
import type { ProjectMember } from '$lib/api/org-users.js'
import type { ServiceEndpoint, ServiceEndpointDetail } from '$lib/api/service-endpoints.js'

/** One contribution at a point, as the point's virtual module lists it (already in `order`). */
export interface InjectionEntry {
  id: string
  order: number
  component: Component<Record<string, unknown>>
}

/** What every point receives: where the page is. */
export interface StandardPointProps {
  routeId: string
  params: Record<string, string>
}

export interface ProjectPointProps extends StandardPointProps {
  project: Awaited<ReturnType<typeof getProject>> | null
}

/** The dashboard's selected project; null in the branches that render without one. */
export interface DashboardProjectPointProps extends StandardPointProps {
  project: ProjectSummary | null
}

/**
 * What every point of the credential detail page receives (Story 69.2): the credential (null in the
 * not-found and vault-sealed states), the project, and the caller's roles. `project` is the project
 * layout's result or null; `projectRole` is `project?.role ?? null`; `orgRole` is the caller's org
 * role. These are DISPLAY data, never authorization input: a composed action must authorize through
 * PV's API (RLS and the project role are enforced server-side). Never carries a revealed value, a
 * share token or a step-up secret. Every field is additive, so a fill written against `{ credential }`
 * keeps working.
 *
 * @pv-stable
 */
export interface CredentialPointProps extends StandardPointProps {
  credential: Awaited<ReturnType<typeof getCredential>> | null
  project: Awaited<ReturnType<typeof getProject>> | null
  projectId: string
  credentialId: string
  orgRole: OrgRole
  projectRole: Awaited<ReturnType<typeof getProject>>['role'] | null
}

/** Story 69.4: the settings audit page. The ungated regions (header, notice, navigation) carry only
 * the viewer's role and whether PV let them in; the owner-only regions carry the loaded results. */
export interface SettingsAuditPointProps extends StandardPointProps {
  orgRole: AuthUser['orgRole']
  allowed: boolean
}

export interface SettingsAuditResultsPointProps extends SettingsAuditPointProps {
  filters: Partial<
    Record<'actorId' | 'eventType' | 'resourceId' | 'projectId' | 'from' | 'to', string>
  >
  events: readonly AuditEventItem[]
  page: number
  total: number
  hasNext: boolean
  errorMessage: string | null
}

/** Story 69.4: the settings notifications page. */
export interface NotificationSettingsPointProps extends StandardPointProps {
  isAdmin: boolean
  canSendTest: boolean
}

export interface NotificationPreferencesPointProps extends NotificationSettingsPointProps {
  preferences: readonly PreferenceItem[]
}

export interface NotificationRoutingPointProps extends NotificationSettingsPointProps {
  routing: readonly RoutingItem[]
}

/** Story 69.4: the project members page. The ungated regions get no member or invitation data. */
export interface ProjectMembersBasePointProps extends StandardPointProps {
  projectId: string
  userId: string
  canManage: boolean
  canManageMembers: boolean
  canTransferOwnership: boolean
}

export interface ProjectMembersPointProps extends ProjectMembersBasePointProps {
  members: readonly ProjectMember[]
}

export interface ProjectMembersInvitationsPointProps extends ProjectMembersBasePointProps {
  invitations: readonly ProjectInvitation[]
}

/** The service-endpoint pages (Story 69.3): the project (the layout's, null when it was not found)
 * plus the caller's org role, which gates the management controls. */
export interface EndpointRolePointProps extends ProjectPointProps {
  orgRole: OrgRole
}

/** The endpoint list page's context, handed to each of its regions: the endpoints are the page's own
 * (optimistic) list. */
export interface EndpointListPointProps extends EndpointRolePointProps {
  endpoints: ServiceEndpointDetail[]
}

/** One endpoint: a list row, or any region of the endpoint detail page that has an endpoint. */
export interface EndpointRowPointProps extends EndpointRolePointProps {
  endpoint: ServiceEndpointDetail
}

/** The endpoint detail page's not-found state: there is no endpoint (the project may exist). */
export interface EndpointNotFoundPointProps extends ProjectPointProps {
  endpoint: null
}

/** The status page admin screen's context, handed to each region that is not the link card. */
export interface StatusPageAdminPointProps extends ProjectPointProps {
  capabilities: CapabilityMap
  serviceEndpoints: ServiceEndpoint[]
}

/** The "Shareable link" card. NEVER the token or the URL built from it (Story 69.3 AC-6.6): a
 * contribution gets flags, the component keeps the secret. */
export interface StatusPageLinkPointProps extends ProjectPointProps {
  hasPublicUrl: boolean
  isLegacy: boolean
}

/** The public status list. `PublicStatusPage` is public-safe by construction (no token). */
export interface PublicStatusPointProps extends StandardPointProps {
  statusPage: PublicStatusPage
}

export interface InjectionPointProps {
  'app.layout.after': StandardPointProps
  'app.layout.before': StandardPointProps
  'app.layout.header.actions': StandardPointProps
  'auth.handoff.after': StandardPointProps
  'auth.handoff.before': StandardPointProps
  'auth.handoff.header.actions': StandardPointProps
  'auth.invitations-accept.after': StandardPointProps
  'auth.invitations-accept.before': StandardPointProps
  'auth.invitations-accept.header.actions': StandardPointProps
  'auth.layout.after': StandardPointProps
  'auth.layout.before': StandardPointProps
  'auth.layout.header.actions': StandardPointProps
  'auth.login.after': StandardPointProps
  'auth.login.before': StandardPointProps
  'auth.login.header.actions': StandardPointProps
  'auth.recovery-detail.after': StandardPointProps
  'auth.recovery-detail.before': StandardPointProps
  'auth.recovery-detail.header.actions': StandardPointProps
  'auth.recovery.after': StandardPointProps
  'auth.recovery.before': StandardPointProps
  'auth.recovery.header.actions': StandardPointProps
  'auth.register.after': StandardPointProps
  'auth.register.before': StandardPointProps
  'auth.register.header.actions': StandardPointProps
  'credential.detail.actions': CredentialPointProps
  'credential.detail.after': CredentialPointProps
  'credential.detail.before': CredentialPointProps
  'credential.detail.dependencies': CredentialPointProps
  'credential.detail.footer': CredentialPointProps
  'credential.detail.header.actions': CredentialPointProps
  'credential.detail.lifecycle': CredentialPointProps
  'credential.detail.metadata': CredentialPointProps
  'credential.detail.not-found': CredentialPointProps
  'credential.detail.nudges': CredentialPointProps
  'credential.detail.rotation': CredentialPointProps
  'credential.detail.shares': CredentialPointProps
  'credential.detail.summary': CredentialPointProps
  'credential.detail.value': CredentialPointProps
  'credential.detail.vault-sealed': CredentialPointProps
  'credential.detail.versions': CredentialPointProps
  'credentials.home.after': StandardPointProps
  'credentials.home.before': StandardPointProps
  'credentials.home.header.actions': StandardPointProps
  'credentials.import.after': StandardPointProps
  'credentials.import.before': StandardPointProps
  'credentials.import.header.actions': StandardPointProps
  'dashboard.home.activity': DashboardProjectPointProps
  'dashboard.home.after': StandardPointProps
  'dashboard.home.before': StandardPointProps
  'dashboard.home.empty': StandardPointProps
  'dashboard.home.header.actions': StandardPointProps
  'dashboard.home.monitoring': DashboardProjectPointProps
  'dashboard.home.org-summary': StandardPointProps
  'dashboard.home.project-summary': DashboardProjectPointProps
  'dashboard.home.rotations': DashboardProjectPointProps
  'dashboard.home.suggested-actions': DashboardProjectPointProps
  'dashboard.home.summary-unavailable': DashboardProjectPointProps
  'dashboard.home.vault-sealed': StandardPointProps
  'extensions.panels-detail.after': StandardPointProps
  'extensions.panels-detail.before': StandardPointProps
  'extensions.panels-detail.header.actions': StandardPointProps
  'external-shares.detail.after': StandardPointProps
  'external-shares.detail.before': StandardPointProps
  'external-shares.detail.header.actions': StandardPointProps
  'health.home.after': StandardPointProps
  'health.home.before': StandardPointProps
  'health.home.header.actions': StandardPointProps
  'notifications.home.after': StandardPointProps
  'notifications.home.before': StandardPointProps
  'notifications.home.header.actions': StandardPointProps
  'platform.audit.after': StandardPointProps
  'platform.audit.before': StandardPointProps
  'platform.audit.header.actions': StandardPointProps
  'platform.backups.after': StandardPointProps
  'platform.backups.before': StandardPointProps
  'platform.backups.header.actions': StandardPointProps
  'platform.home.after': StandardPointProps
  'platform.home.before': StandardPointProps
  'platform.home.header.actions': StandardPointProps
  'platform.settings-orgs.after': StandardPointProps
  'platform.settings-orgs.before': StandardPointProps
  'platform.settings-orgs.header.actions': StandardPointProps
  'platform.settings-resource-usage.after': StandardPointProps
  'platform.settings-resource-usage.before': StandardPointProps
  'platform.settings-resource-usage.header.actions': StandardPointProps
  'platform.settings.after': StandardPointProps
  'platform.settings.before': StandardPointProps
  'platform.settings.header.actions': StandardPointProps
  'platform.upgrade.after': StandardPointProps
  'platform.upgrade.before': StandardPointProps
  'platform.upgrade.header.actions': StandardPointProps
  'project.certificates-detail.after': StandardPointProps
  'project.certificates-detail.before': StandardPointProps
  'project.certificates-detail.header.actions': StandardPointProps
  'project.certificates-new.after': StandardPointProps
  'project.certificates-new.before': StandardPointProps
  'project.certificates-new.header.actions': StandardPointProps
  'project.certificates.after': StandardPointProps
  'project.certificates.before': StandardPointProps
  'project.certificates.header.actions': StandardPointProps
  'project.credentials-import.after': StandardPointProps
  'project.credentials-import.before': StandardPointProps
  'project.credentials-import.header.actions': StandardPointProps
  'project.credentials-new.after': StandardPointProps
  'project.credentials-new.before': StandardPointProps
  'project.credentials-new.header.actions': StandardPointProps
  'project.credentials-rotate.after': StandardPointProps
  'project.credentials-rotate.before': StandardPointProps
  'project.credentials-rotate.header.actions': StandardPointProps
  'project.credentials-rotations-detail.after': StandardPointProps
  'project.credentials-rotations-detail.before': StandardPointProps
  'project.credentials-rotations-detail.header.actions': StandardPointProps
  'project.credentials.after': StandardPointProps
  'project.credentials.before': StandardPointProps
  'project.credentials.header.actions': StandardPointProps
  'project.detail.after': ProjectPointProps
  'project.detail.before': ProjectPointProps
  'project.detail.export': ProjectPointProps
  'project.detail.header.actions': ProjectPointProps
  'project.detail.not-found': ProjectPointProps
  'project.detail.summary': ProjectPointProps
  'project.detail.tiles': ProjectPointProps
  'project.domains-detail.after': StandardPointProps
  'project.domains-detail.before': StandardPointProps
  'project.domains-detail.header.actions': StandardPointProps
  'project.domains-new.after': StandardPointProps
  'project.domains-new.before': StandardPointProps
  'project.domains-new.header.actions': StandardPointProps
  'project.domains.after': StandardPointProps
  'project.domains.before': StandardPointProps
  'project.domains.header.actions': StandardPointProps
  'project.home.after': StandardPointProps
  'project.home.before': StandardPointProps
  'project.home.header.actions': StandardPointProps
  'project.import.after': StandardPointProps
  'project.import.before': StandardPointProps
  'project.import.header.actions': StandardPointProps
  'project.layout.after': ProjectPointProps
  'project.layout.before': ProjectPointProps
  'project.layout.header.actions': ProjectPointProps
  'project.layout.nav': ProjectPointProps
  'project.machine-users-detail.after': StandardPointProps
  'project.machine-users-detail.before': StandardPointProps
  'project.machine-users-detail.header.actions': StandardPointProps
  'project.machine-users-new.after': StandardPointProps
  'project.machine-users-new.before': StandardPointProps
  'project.machine-users-new.header.actions': StandardPointProps
  'project.machine-users.after': StandardPointProps
  'project.machine-users.before': StandardPointProps
  'project.machine-users.header.actions': StandardPointProps
  'project.members.after': StandardPointProps
  'project.members.before': StandardPointProps
  'project.members.header.actions': StandardPointProps
  'project.new.after': StandardPointProps
  'project.new.before': StandardPointProps
  'project.new.header.actions': StandardPointProps
  'project.preview.after': StandardPointProps
  'project.preview.before': StandardPointProps
  'project.preview.header.actions': StandardPointProps
  'project.service-endpoints-detail.after': StandardPointProps
  'project.service-endpoints-detail.before': StandardPointProps
  'project.service-endpoints-detail.delete': EndpointRowPointProps
  'project.service-endpoints-detail.header.actions': StandardPointProps
  'project.service-endpoints-detail.history': EndpointRowPointProps
  'project.service-endpoints-detail.not-found': EndpointNotFoundPointProps
  'project.service-endpoints-detail.pause': EndpointRowPointProps
  'project.service-endpoints-detail.settings': EndpointRowPointProps
  'project.service-endpoints-detail.title': EndpointRowPointProps
  'project.service-endpoints-new.after': StandardPointProps
  'project.service-endpoints-new.before': StandardPointProps
  'project.service-endpoints-new.form': EndpointRolePointProps
  'project.service-endpoints-new.header': EndpointRolePointProps
  'project.service-endpoints-new.header.actions': StandardPointProps
  'project.service-endpoints.after': StandardPointProps
  'project.service-endpoints.alerts': EndpointListPointProps
  'project.service-endpoints.before': StandardPointProps
  'project.service-endpoints.empty': EndpointListPointProps
  'project.service-endpoints.header': EndpointListPointProps
  'project.service-endpoints.header.actions': StandardPointProps
  'project.service-endpoints.not-found': EndpointListPointProps
  'project.service-endpoints.row': EndpointRowPointProps
  'project.service-endpoints.table': EndpointListPointProps
  'project.services-detail.after': StandardPointProps
  'project.services-detail.before': StandardPointProps
  'project.services-detail.header.actions': StandardPointProps
  'project.services-new.after': StandardPointProps
  'project.services-new.before': StandardPointProps
  'project.services-new.header.actions': StandardPointProps
  'project.services.after': StandardPointProps
  'project.services.before': StandardPointProps
  'project.services.header.actions': StandardPointProps
  'project.status-page.after': StandardPointProps
  'project.status-page.before': StandardPointProps
  'project.status-page.disabled': StatusPageAdminPointProps
  'project.status-page.header': StatusPageAdminPointProps
  'project.status-page.header.actions': StandardPointProps
  'project.status-page.link': StatusPageLinkPointProps
  'project.status-page.read-only': StatusPageAdminPointProps
  'project.status-page.services': StatusPageAdminPointProps
  'root.error.after': StandardPointProps
  'root.error.before': StandardPointProps
  'root.error.header.actions': StandardPointProps
  'root.home.after': StandardPointProps
  'root.home.before': StandardPointProps
  'root.home.header.actions': StandardPointProps
  'root.layout.after': StandardPointProps
  'root.layout.before': StandardPointProps
  'root.layout.header.actions': StandardPointProps
  'settings.audit-access-report.after': StandardPointProps
  'settings.audit-access-report.before': StandardPointProps
  'settings.audit-access-report.header.actions': StandardPointProps
  'settings.audit-forwarding.after': StandardPointProps
  'settings.audit-forwarding.before': StandardPointProps
  'settings.audit-forwarding.header.actions': StandardPointProps
  'settings.audit.after': StandardPointProps
  'settings.audit.before': StandardPointProps
  'settings.audit.header.actions': StandardPointProps
  'settings.extensions.after': StandardPointProps
  'settings.extensions.before': StandardPointProps
  'settings.extensions.header.actions': StandardPointProps
  'settings.external-identities.after': StandardPointProps
  'settings.external-identities.before': StandardPointProps
  'settings.external-identities.header.actions': StandardPointProps
  'settings.home.after': StandardPointProps
  'settings.home.before': StandardPointProps
  'settings.home.header.actions': StandardPointProps
  'settings.language.after': StandardPointProps
  'settings.language.before': StandardPointProps
  'settings.language.header.actions': StandardPointProps
  'settings.notifications.after': StandardPointProps
  'settings.notifications.before': StandardPointProps
  'settings.notifications.header.actions': StandardPointProps
  'settings.security.after': StandardPointProps
  'settings.security.before': StandardPointProps
  'settings.security.header.actions': StandardPointProps
  'settings.sso-domains.after': StandardPointProps
  'settings.sso-domains.before': StandardPointProps
  'settings.sso-domains.header.actions': StandardPointProps
  'settings.themes.after': StandardPointProps
  'settings.themes.before': StandardPointProps
  'settings.themes.header.actions': StandardPointProps
  'settings.users-erasure-detail.after': StandardPointProps
  'settings.users-erasure-detail.before': StandardPointProps
  'settings.users-erasure-detail.header.actions': StandardPointProps
  'settings.users.after': StandardPointProps
  'settings.users.before': StandardPointProps
  'settings.users.header.actions': StandardPointProps
  'shares.detail.after': StandardPointProps
  'shares.detail.before': StandardPointProps
  'shares.detail.header.actions': StandardPointProps
  'shell.body.end': StandardPointProps
  'shell.head': StandardPointProps
  'shell.header.end': StandardPointProps
  'status.detail.after': StandardPointProps
  'status.detail.before': StandardPointProps
  'status.detail.header': StandardPointProps
  'status.detail.header.actions': StandardPointProps
  'settings.audit.error': SettingsAuditResultsPointProps
  'settings.audit.export': SettingsAuditPointProps
  'settings.audit.header': SettingsAuditPointProps
  'settings.audit.navigation': SettingsAuditPointProps
  'settings.audit.notice': SettingsAuditPointProps
  'settings.audit.results': SettingsAuditResultsPointProps
  'settings.audit.search': SettingsAuditResultsPointProps
  'settings.audit.verify': SettingsAuditPointProps
  'settings.notifications.channels': NotificationPreferencesPointProps
  'settings.notifications.header': NotificationSettingsPointProps
  'settings.notifications.routing': NotificationRoutingPointProps
  'settings.notifications.test': NotificationSettingsPointProps
  'project.members.access': ProjectMembersPointProps
  'project.members.header': ProjectMembersBasePointProps
  'project.members.invitations': ProjectMembersInvitationsPointProps
  'project.members.invite': ProjectMembersBasePointProps
  'project.members.notice': ProjectMembersBasePointProps
  'root.error.header': StandardPointProps
  'root.error.content': StandardPointProps
  'root.layout.body': StandardPointProps
  'root.home.content': StandardPointProps
  'app.layout.theme': StandardPointProps
  'app.layout.shell': StandardPointProps
  'credentials.home.header': StandardPointProps
  'credentials.home.projects': StandardPointProps
  'credentials.import.header': StandardPointProps
  'credentials.import.projects': StandardPointProps
  'extensions.panels-detail.content': StandardPointProps
  'health.home.header': StandardPointProps
  'health.home.projects': StandardPointProps
  'notifications.home.header': StandardPointProps
  'notifications.home.machine-dormancy': StandardPointProps
  'notifications.home.user-dormancy': StandardPointProps
  'notifications.home.tabs': StandardPointProps
  'notifications.home.list': StandardPointProps
  'platform.home.header': StandardPointProps
  'platform.audit.content': StandardPointProps
  'platform.backups.content': StandardPointProps
  'platform.settings.content': StandardPointProps
  'platform.settings-orgs.content': StandardPointProps
  'platform.settings-resource-usage.content': StandardPointProps
  'platform.upgrade.content': StandardPointProps
  'project.home.header': StandardPointProps
  'project.home.error': StandardPointProps
  'project.home.list': StandardPointProps
  'project.certificates.list': StandardPointProps
  'project.certificates-detail.content': StandardPointProps
  'project.certificates-new.header': StandardPointProps
  'project.certificates-new.form': StandardPointProps
  'project.credentials.header': StandardPointProps
  'project.credentials.list': StandardPointProps
  'project.credentials-rotate.header': StandardPointProps
  'project.credentials-rotate.form': StandardPointProps
  'project.credentials-rotations-detail.content': StandardPointProps
  'project.credentials-import.header': StandardPointProps
  'project.credentials-import.content': StandardPointProps
  'project.credentials-new.header': StandardPointProps
  'project.credentials-new.form': StandardPointProps
  'project.domains.list': StandardPointProps
  'project.domains-detail.content': StandardPointProps
  'project.domains-new.header': StandardPointProps
  'project.domains-new.form': StandardPointProps
  'project.machine-users.header': StandardPointProps
  'project.machine-users.list': StandardPointProps
  'project.machine-users-detail.content': StandardPointProps
  'project.machine-users-new.header': StandardPointProps
  'project.machine-users-new.form': StandardPointProps
  'project.services.list': StandardPointProps
  'project.services-detail.content': StandardPointProps
  'project.services-new.header': StandardPointProps
  'project.services-new.form': StandardPointProps
  'project.import.header': StandardPointProps
  'project.import.content': StandardPointProps
  'project.new.header': StandardPointProps
  'project.new.form': StandardPointProps
  'project.preview.content': StandardPointProps
  'settings.home.header': StandardPointProps
  'settings.audit-access-report.header': StandardPointProps
  'settings.audit-access-report.report': StandardPointProps
  'settings.audit-forwarding.header': StandardPointProps
  'settings.audit-forwarding.config': StandardPointProps
  'settings.extensions.header': StandardPointProps
  'settings.extensions.status': StandardPointProps
  'settings.external-identities.header': StandardPointProps
  'settings.external-identities.panel': StandardPointProps
  'settings.language.header': StandardPointProps
  'settings.language.errors': StandardPointProps
  'settings.language.options': StandardPointProps
  'settings.security.header': StandardPointProps
  'settings.sso-domains.header': StandardPointProps
  'settings.sso-domains.panel': StandardPointProps
  'settings.themes.header': StandardPointProps
  'settings.themes.selection-error': StandardPointProps
  'settings.themes.list': StandardPointProps
  'settings.themes.admin': StandardPointProps
  'settings.users.header': StandardPointProps
  'settings.users.management': StandardPointProps
  'settings.users-erasure-detail.header': StandardPointProps
  'settings.users-erasure-detail.request': StandardPointProps
  'shares.detail.heading': StandardPointProps
  'shares.detail.body': StandardPointProps
  'auth.layout.theme': StandardPointProps
  'auth.layout.footer': StandardPointProps
  'auth.layout.body': StandardPointProps
  'auth.handoff.content': StandardPointProps
  'auth.invitations-accept.content': StandardPointProps
  'auth.login.heading': StandardPointProps
  'auth.login.reason': StandardPointProps
  'auth.login.links': StandardPointProps
  'auth.login.form': StandardPointProps
  'auth.recovery.heading': StandardPointProps
  'auth.recovery.request': StandardPointProps
  'auth.recovery.login-link': StandardPointProps
  'auth.recovery-detail.content': StandardPointProps
  'auth.register.heading': StandardPointProps
  'auth.register.login-link': StandardPointProps
  'vault.home.header': StandardPointProps
  'external-shares.detail.heading': StandardPointProps
  'external-shares.detail.body': StandardPointProps
  'status.detail.services': PublicStatusPointProps
  'status.detail.unavailable': StandardPointProps
  'vault.home.after': StandardPointProps
  'vault.home.before': StandardPointProps
  'vault.home.header.actions': StandardPointProps
  'app.layout.search': StandardPointProps
  'project.layout.content': ProjectPointProps
  'root.layout.progress': StandardPointProps
  'auth.layout.brand': StandardPointProps
  'auth.register.form': StandardPointProps
  'vault.home.gate': StandardPointProps
  'platform.home.operator-notice': StandardPointProps
  'platform.home.warnings': StandardPointProps
  'platform.home.nav-cards': StandardPointProps
  'settings.home.nav-cards': StandardPointProps
  'settings.audit-access-report.back': StandardPointProps
  'settings.audit-forwarding.back': StandardPointProps
  'settings.language.back': StandardPointProps
  'settings.themes.back': StandardPointProps
  'settings.users-erasure-detail.back': StandardPointProps
  'settings.security.enrollment': StandardPointProps
  'project.certificates.list-header': StandardPointProps
  'project.domains.list-header': StandardPointProps
  'project.services.list-header': StandardPointProps
  'project.status-page.error': ProjectPointProps
  'project.service-endpoints-detail.back': EndpointRowPointProps
}

export type InjectionPointName = keyof InjectionPointProps

/** What a page passes in `props`: the entity props beyond the standard ones. */
export type InjectionPointExtras<N extends InjectionPointName> = Omit<
  InjectionPointProps[N],
  keyof StandardPointProps
>

export type InjectionPointKind = 'standard' | 'shell' | 'region'

export interface InjectionPointDefinition {
  name: InjectionPointName
  kind: InjectionPointKind
  propsType: string
  /** For a shell point rendered inside a shared component: the route whose layout load feeds it. */
  hostRouteId?: string
  /** For a region point: the `<routeId>#<scope>` host routes that render its component. The pack
   * script derives the same list from the import graph and the guards fail on a mismatch, so this
   * declaration is checked, never trusted. A contribution's `hostRoutes` opt-in names these. */
  hostRoutes?: readonly string[]
}

const POINT_POSITIONS = ['after', 'before', 'header.actions'] as const

/** The three standard points (`<page>.after`, `.before`, `.header.actions`) of each page, all taking
 * `propsType`. `check-injection-point-coverage` reads these calls with the TypeScript parser, so the
 * arguments stay string literals. */
function pagePoints(propsType: string, pages: readonly string[]): InjectionPointDefinition[] {
  return pages.flatMap((page) =>
    POINT_POSITIONS.map((position) => ({
      name: `${page}.${position}` as InjectionPointName,
      kind: 'standard' as const,
      propsType,
    }))
  )
}

/** Region points (Story 69.1): `<area>.<page>.<region>` points rendered inside a shared component,
 * all hosted by the same routes. `check-injection-point-coverage` reads these calls with the
 * TypeScript parser, so the arguments stay string literals (a host route may be a top-level string constant). */
function regionPoints(
  propsType: string,
  hostRoutes: readonly string[],
  names: readonly string[]
): InjectionPointDefinition[] {
  return names.map((name) => ({
    name: name as InjectionPointName,
    kind: 'region' as const,
    propsType,
    hostRoutes,
  }))
}

// The phase 5 pages' host routes, named once because three region rows share each of them (the
// coverage guard resolves a top-level string constant used in a `regionPoints` host list).
const AUDIT_PAGE_HOST = '/(app)/settings/audit#page'
const NOTIFICATIONS_PAGE_HOST = '/(app)/settings/notifications#page'
const MEMBERS_PAGE_HOST = '/(app)/projects/[projectId]/members#page'
const STATUS_PAGE_HOST = '/(app)/projects/[projectId]/status-page#page'
const ENDPOINT_DETAIL_PAGE_HOST =
  '/(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]#page'

export const INJECTION_POINTS: readonly InjectionPointDefinition[] = [
  ...pagePoints('StandardPointProps', ['app.layout']),
  ...pagePoints('StandardPointProps', [
    'auth.handoff',
    'auth.invitations-accept',
    'auth.layout',
    'auth.login',
    'auth.recovery-detail',
    'auth.recovery',
    'auth.register',
  ]),
  ...pagePoints('CredentialPointProps', ['credential.detail']),
  ...regionPoints(
    'CredentialPointProps',
    ['/(app)/projects/[projectId]/credentials/[credentialId]#page'],
    [
      'credential.detail.actions',
      'credential.detail.dependencies',
      'credential.detail.footer',
      'credential.detail.lifecycle',
      'credential.detail.metadata',
      'credential.detail.not-found',
      'credential.detail.nudges',
      'credential.detail.rotation',
      'credential.detail.shares',
      'credential.detail.summary',
      'credential.detail.value',
      'credential.detail.vault-sealed',
      'credential.detail.versions',
    ]
  ),
  ...pagePoints('StandardPointProps', [
    'credentials.home',
    'credentials.import',
    'dashboard.home',
    'extensions.panels-detail',
    'external-shares.detail',
    'health.home',
    'notifications.home',
  ]),
  ...pagePoints('StandardPointProps', [
    'platform.audit',
    'platform.backups',
    'platform.home',
    'platform.settings-orgs',
    'platform.settings-resource-usage',
    'platform.settings',
    'platform.upgrade',
  ]),
  ...pagePoints('StandardPointProps', [
    'project.certificates-detail',
    'project.certificates-new',
    'project.certificates',
    'project.credentials-import',
    'project.credentials-new',
    'project.credentials-rotate',
    'project.credentials-rotations-detail',
    'project.credentials',
    'project.domains-detail',
    'project.domains-new',
    'project.domains',
    'project.home',
    'project.import',
    'project.machine-users-detail',
    'project.machine-users-new',
    'project.machine-users',
    'project.members',
    'project.new',
    'project.preview',
    'project.service-endpoints-detail',
    'project.service-endpoints-new',
    'project.service-endpoints',
    'project.services-detail',
    'project.services-new',
    'project.services',
    'project.status-page',
  ]),
  ...pagePoints('ProjectPointProps', ['project.detail', 'project.layout']),
  ...regionPoints(
    'ProjectPointProps',
    ['/(app)/projects/[projectId]#page'],
    [
      'project.detail.export',
      'project.detail.not-found',
      'project.detail.summary',
      'project.detail.tiles',
    ]
  ),
  ...regionPoints(
    'ProjectPointProps',
    ['/(app)/projects/[projectId]#layout'],
    ['project.layout.nav']
  ),
  ...regionPoints(
    'DashboardProjectPointProps',
    ['/(app)/dashboard#page'],
    [
      'dashboard.home.activity',
      'dashboard.home.monitoring',
      'dashboard.home.project-summary',
      'dashboard.home.rotations',
      'dashboard.home.suggested-actions',
      'dashboard.home.summary-unavailable',
    ]
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/dashboard#page'],
    ['dashboard.home.empty', 'dashboard.home.org-summary', 'dashboard.home.vault-sealed']
  ),
  ...regionPoints(
    'EndpointListPointProps',
    ['/(app)/projects/[projectId]/service-endpoints#page'],
    [
      'project.service-endpoints.alerts',
      'project.service-endpoints.empty',
      'project.service-endpoints.header',
      'project.service-endpoints.not-found',
      'project.service-endpoints.table',
    ]
  ),
  ...regionPoints(
    'EndpointRowPointProps',
    ['/(app)/projects/[projectId]/service-endpoints#page'],
    ['project.service-endpoints.row']
  ),
  ...regionPoints(
    'EndpointRolePointProps',
    ['/(app)/projects/[projectId]/service-endpoints/new#page'],
    ['project.service-endpoints-new.form', 'project.service-endpoints-new.header']
  ),
  ...regionPoints(
    'EndpointRowPointProps',
    [ENDPOINT_DETAIL_PAGE_HOST],
    [
      'project.service-endpoints-detail.delete',
      'project.service-endpoints-detail.history',
      'project.service-endpoints-detail.pause',
      'project.service-endpoints-detail.settings',
      'project.service-endpoints-detail.title',
    ]
  ),
  ...regionPoints(
    'EndpointNotFoundPointProps',
    [ENDPOINT_DETAIL_PAGE_HOST],
    ['project.service-endpoints-detail.not-found']
  ),
  ...regionPoints(
    'StatusPageAdminPointProps',
    [STATUS_PAGE_HOST],
    [
      'project.status-page.disabled',
      'project.status-page.header',
      'project.status-page.read-only',
      'project.status-page.services',
    ]
  ),
  ...regionPoints('StatusPageLinkPointProps', [STATUS_PAGE_HOST], ['project.status-page.link']),
  ...regionPoints(
    'StandardPointProps',
    ['/status/[token]#page'],
    ['status.detail.header', 'status.detail.unavailable']
  ),
  ...regionPoints('PublicStatusPointProps', ['/status/[token]#page'], ['status.detail.services']),
  ...pagePoints('StandardPointProps', [
    'settings.audit-access-report',
    'settings.audit-forwarding',
    'settings.audit',
    'settings.extensions',
    'settings.external-identities',
    'settings.home',
    'settings.language',
    'settings.notifications',
    'settings.security',
    'settings.sso-domains',
    'settings.themes',
    'settings.users-erasure-detail',
    'settings.users',
  ]),
  ...pagePoints('StandardPointProps', [
    'root.error',
    'root.home',
    'root.layout',
    'shares.detail',
    'status.detail',
    'vault.home',
  ]),
  ...regionPoints(
    'SettingsAuditPointProps',
    [AUDIT_PAGE_HOST],
    [
      'settings.audit.export',
      'settings.audit.header',
      'settings.audit.navigation',
      'settings.audit.notice',
      'settings.audit.verify',
    ]
  ),
  ...regionPoints(
    'SettingsAuditResultsPointProps',
    [AUDIT_PAGE_HOST],
    ['settings.audit.error', 'settings.audit.results', 'settings.audit.search']
  ),
  ...regionPoints(
    'NotificationSettingsPointProps',
    [NOTIFICATIONS_PAGE_HOST],
    ['settings.notifications.header', 'settings.notifications.test']
  ),
  ...regionPoints(
    'NotificationPreferencesPointProps',
    [NOTIFICATIONS_PAGE_HOST],
    ['settings.notifications.channels']
  ),
  ...regionPoints(
    'NotificationRoutingPointProps',
    [NOTIFICATIONS_PAGE_HOST],
    ['settings.notifications.routing']
  ),
  ...regionPoints(
    'ProjectMembersBasePointProps',
    [MEMBERS_PAGE_HOST],
    ['project.members.header', 'project.members.invite', 'project.members.notice']
  ),
  ...regionPoints('ProjectMembersPointProps', [MEMBERS_PAGE_HOST], ['project.members.access']),
  ...regionPoints(
    'ProjectMembersInvitationsPointProps',
    [MEMBERS_PAGE_HOST],
    ['project.members.invitations']
  ),
  ...regionPoints('StandardPointProps', ['/#layout'], ['root.layout.body']),
  ...regionPoints('StandardPointProps', ['/#page'], ['root.home.content']),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)#layout'],
    ['app.layout.theme', 'app.layout.shell']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/credentials#page'],
    ['credentials.home.header', 'credentials.home.projects']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/credentials/import#page'],
    ['credentials.import.header', 'credentials.import.projects']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/extensions/panels/[slot]/[...subpath]#page'],
    ['extensions.panels-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/health#page'],
    ['health.home.header', 'health.home.projects']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/notifications#page'],
    [
      'notifications.home.header',
      'notifications.home.machine-dormancy',
      'notifications.home.user-dormancy',
      'notifications.home.tabs',
      'notifications.home.list',
    ]
  ),
  ...regionPoints('StandardPointProps', ['/(app)/platform#page'], ['platform.home.header']),
  ...regionPoints('StandardPointProps', ['/(app)/platform/audit#page'], ['platform.audit.content']),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/platform/backups#page'],
    ['platform.backups.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/platform/settings#page'],
    ['platform.settings.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/platform/settings/orgs#page'],
    ['platform.settings-orgs.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/platform/settings/resource-usage#page'],
    ['platform.settings-resource-usage.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/platform/upgrade#page'],
    ['platform.upgrade.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects#page'],
    ['project.home.header', 'project.home.error', 'project.home.list']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/certificates#page'],
    ['project.certificates.list']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/certificates/[certificateId]#page'],
    ['project.certificates-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/certificates/new#page'],
    ['project.certificates-new.header', 'project.certificates-new.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/credentials#page'],
    ['project.credentials.header', 'project.credentials.list']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/credentials/[credentialId]/rotate#page'],
    ['project.credentials-rotate.header', 'project.credentials-rotate.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]#page'],
    ['project.credentials-rotations-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/credentials/import#page'],
    ['project.credentials-import.header', 'project.credentials-import.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/credentials/new#page'],
    ['project.credentials-new.header', 'project.credentials-new.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/domains#page'],
    ['project.domains.list']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/domains/[domainId]#page'],
    ['project.domains-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/domains/new#page'],
    ['project.domains-new.header', 'project.domains-new.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/machine-users#page'],
    ['project.machine-users.header', 'project.machine-users.list']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/machine-users/[machineUserId]#page'],
    ['project.machine-users-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/machine-users/new#page'],
    ['project.machine-users-new.header', 'project.machine-users-new.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/services#page'],
    ['project.services.list']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/services/[serviceId]#page'],
    ['project.services-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/services/new#page'],
    ['project.services-new.header', 'project.services-new.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/import#page'],
    ['project.import.header', 'project.import.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/new#page'],
    ['project.new.header', 'project.new.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/preview#page'],
    ['project.preview.content']
  ),
  ...regionPoints('StandardPointProps', ['/(app)/settings#page'], ['settings.home.header']),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/audit/access-report#page'],
    ['settings.audit-access-report.header', 'settings.audit-access-report.report']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/audit/forwarding#page'],
    ['settings.audit-forwarding.header', 'settings.audit-forwarding.config']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/extensions#page'],
    ['settings.extensions.header', 'settings.extensions.status']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/external-identities#page'],
    ['settings.external-identities.header', 'settings.external-identities.panel']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/language#page'],
    ['settings.language.header', 'settings.language.errors', 'settings.language.options']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/security#page'],
    ['settings.security.header']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/sso-domains#page'],
    ['settings.sso-domains.header', 'settings.sso-domains.panel']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/themes#page'],
    [
      'settings.themes.header',
      'settings.themes.selection-error',
      'settings.themes.list',
      'settings.themes.admin',
    ]
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/users#page'],
    ['settings.users.header', 'settings.users.management']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/users/[userId]/erasure/[requestId]#page'],
    ['settings.users-erasure-detail.header', 'settings.users-erasure-detail.request']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/shares/[token]#page'],
    ['shares.detail.heading', 'shares.detail.body']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(auth)#layout'],
    ['auth.layout.theme', 'auth.layout.footer', 'auth.layout.body']
  ),
  ...regionPoints('StandardPointProps', ['/(auth)/handoff#page'], ['auth.handoff.content']),
  ...regionPoints(
    'StandardPointProps',
    ['/(auth)/invitations/accept#page'],
    ['auth.invitations-accept.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(auth)/login#page'],
    ['auth.login.heading', 'auth.login.reason', 'auth.login.links', 'auth.login.form']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(auth)/recovery#page'],
    ['auth.recovery.heading', 'auth.recovery.request', 'auth.recovery.login-link']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(auth)/recovery/[token]#page'],
    ['auth.recovery-detail.content']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(auth)/register#page'],
    ['auth.register.heading', 'auth.register.login-link']
  ),
  ...regionPoints('StandardPointProps', ['/(vault)/vault#page'], ['vault.home.header']),
  ...regionPoints(
    'StandardPointProps',
    ['/external-shares/[token]#page'],
    ['external-shares.detail.heading', 'external-shares.detail.body']
  ),
  ...regionPoints('StandardPointProps', ['/(app)#layout'], ['app.layout.search']),
  ...regionPoints(
    'ProjectPointProps',
    ['/(app)/projects/[projectId]#layout'],
    ['project.layout.content']
  ),
  ...regionPoints('StandardPointProps', ['/#layout'], ['root.layout.progress']),
  ...regionPoints('StandardPointProps', ['/(auth)#layout'], ['auth.layout.brand']),
  ...regionPoints('StandardPointProps', ['/(auth)/register#page'], ['auth.register.form']),
  ...regionPoints('StandardPointProps', ['/(vault)/vault#page'], ['vault.home.gate']),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/platform#page'],
    ['platform.home.operator-notice', 'platform.home.warnings', 'platform.home.nav-cards']
  ),
  ...regionPoints('StandardPointProps', ['/(app)/settings#page'], ['settings.home.nav-cards']),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/audit/access-report#page'],
    ['settings.audit-access-report.back']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/audit/forwarding#page'],
    ['settings.audit-forwarding.back']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/language#page'],
    ['settings.language.back']
  ),
  ...regionPoints('StandardPointProps', ['/(app)/settings/themes#page'], ['settings.themes.back']),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/users/[userId]/erasure/[requestId]#page'],
    ['settings.users-erasure-detail.back']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/settings/security#page'],
    ['settings.security.enrollment']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/certificates#page'],
    ['project.certificates.list-header']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/domains#page'],
    ['project.domains.list-header']
  ),
  ...regionPoints(
    'StandardPointProps',
    ['/(app)/projects/[projectId]/services#page'],
    ['project.services.list-header']
  ),
  ...regionPoints('ProjectPointProps', [STATUS_PAGE_HOST], ['project.status-page.error']),
  ...regionPoints(
    'EndpointRowPointProps',
    [ENDPOINT_DETAIL_PAGE_HOST],
    ['project.service-endpoints-detail.back']
  ),
  { name: 'root.error.header', kind: 'standard', propsType: 'StandardPointProps' },
  { name: 'root.error.content', kind: 'standard', propsType: 'StandardPointProps' },
  { name: 'shell.body.end', kind: 'shell', propsType: 'StandardPointProps' },
  { name: 'shell.head', kind: 'shell', propsType: 'StandardPointProps' },
  {
    name: 'shell.header.end',
    kind: 'shell',
    propsType: 'StandardPointProps',
    hostRouteId: '/(app)',
  },
]
