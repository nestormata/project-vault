// Story 68.4 AC-2: the typed registry of injection points, the single source of point names.
// `InjectionPointProps` is what a contribution component receives for each point (Q6: the route id
// and params, plus the page's already-loaded primary entity where it has one). `INJECTION_POINTS` is
// the runtime table. `pnpm pack:web-host` joins it with the route files that render each point and
// ships `manifests/injection-points.json` (names, files, route ids, scopes). Names follow
// `<area>.<page>.<region>[.<position>]` (lowercase, dot-separated; `shell.<region>` has two
// segments). Adding a point is a PV change: add it here and render it with a literal name.
import type { Component } from 'svelte'
import type { getCredential } from '$lib/api/credentials.js'
import type { getProject } from '$lib/api/projects.js'

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

export interface CredentialPointProps extends StandardPointProps {
  credential: Awaited<ReturnType<typeof getCredential>> | null
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
  'credential.detail.after': CredentialPointProps
  'credential.detail.before': CredentialPointProps
  'credential.detail.header.actions': CredentialPointProps
  'credentials.home.after': StandardPointProps
  'credentials.home.before': StandardPointProps
  'credentials.home.header.actions': StandardPointProps
  'credentials.import.after': StandardPointProps
  'credentials.import.before': StandardPointProps
  'credentials.import.header.actions': StandardPointProps
  'dashboard.home.after': StandardPointProps
  'dashboard.home.before': StandardPointProps
  'dashboard.home.header.actions': StandardPointProps
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
  'project.detail.header.actions': ProjectPointProps
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
  'project.service-endpoints-detail.header.actions': StandardPointProps
  'project.service-endpoints-new.after': StandardPointProps
  'project.service-endpoints-new.before': StandardPointProps
  'project.service-endpoints-new.header.actions': StandardPointProps
  'project.service-endpoints.after': StandardPointProps
  'project.service-endpoints.before': StandardPointProps
  'project.service-endpoints.header.actions': StandardPointProps
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
  'project.status-page.header.actions': StandardPointProps
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
  'status.detail.header.actions': StandardPointProps
  'vault.home.after': StandardPointProps
  'vault.home.before': StandardPointProps
  'vault.home.header.actions': StandardPointProps
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
  { name: 'shell.body.end', kind: 'shell', propsType: 'StandardPointProps' },
  { name: 'shell.head', kind: 'shell', propsType: 'StandardPointProps' },
  {
    name: 'shell.header.end',
    kind: 'shell',
    propsType: 'StandardPointProps',
    hostRouteId: '/(app)',
  },
]
