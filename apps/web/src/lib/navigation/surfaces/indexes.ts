// Story 68.7 (S8-S12): section indexes, sub-section link rows and the notifications tab bar. Their
// English text is unchanged (translating it is i18n work outside this story, Q6), except the
// Language card, which already reads messages.
import { resolve } from '$app/paths'
import { m } from '$lib/paraglide/messages.js'
import type { NavContexts } from '../types.js'
import type { PvItem, SurfaceBuilder } from './define.js'
import { text } from './define.js'

type Card<S extends keyof NavContexts> = PvItem<NavContexts[S]>

export const settingsIndexItems: SurfaceBuilder<'settings.index'> = () => [
  {
    id: 'settings.index.notifications',
    label: text('Notifications'),
    description: text('Alert delivery channels, frequency, and org routing'),
    href: () => resolve('/settings/notifications'),
  },
  {
    id: 'settings.index.users',
    label: text('Users'),
    description: text('Org-wide members, project roles, and account removal'),
    href: () => resolve('/settings/users'),
  },
  {
    id: 'settings.index.security',
    label: text('Security'),
    description: text('Multi-factor authentication enrollment and recovery codes'),
    href: () => resolve('/settings/security'),
  },
  {
    id: 'settings.index.language',
    label: () => m.settings_nav_language_title(),
    description: () => m.settings_nav_language_description(),
    href: () => resolve('/settings/language'),
  },
  {
    id: 'settings.index.themes',
    label: text('Themes'),
    description: text('Choose which installed theme is active for your view'),
    href: () => resolve('/settings/themes'),
  },
  {
    id: 'settings.index.audit',
    label: text('Audit & Compliance'),
    description: text('Audit log search, export, access reports, and erasure requests'),
    href: () => resolve('/settings/audit'),
  },
  {
    id: 'settings.index.extensions',
    label: text('Extensions'),
    description: text(
      'Whether a configured extension is loaded, not configured, or failed to load'
    ),
    href: () => resolve('/settings/extensions'),
  },
  {
    id: 'settings.index.sso-domains',
    label: text('SSO Domains'),
    description: text('Which email domains route into which SSO provider for this organization'),
    href: () => resolve('/settings/sso-domains'),
  },
  {
    id: 'settings.index.external-identities',
    label: text('External Identities'),
    description: text(
      'Which org members have a linked identity for SSO sign-in, link a new one, or unlink a stale one'
    ),
    href: () => resolve('/settings/external-identities'),
  },
]

export const platformIndexItems: SurfaceBuilder<'platform.index'> = () => [
  {
    id: 'platform.index.backups',
    label: text('Backups'),
    description: text('Trigger, list, validate, and restore encrypted backups'),
    href: () => resolve('/platform/backups'),
  },
  {
    id: 'platform.index.settings',
    label: text('System Settings'),
    description: text('MFA policy, audit storage, organizations, and resource usage'),
    href: () => resolve('/platform/settings'),
  },
  {
    id: 'platform.index.upgrade',
    label: text('Version & Upgrade'),
    description: text('Current version, CLI version policy, and upgrade procedure'),
    href: () => resolve('/platform/upgrade'),
  },
  {
    id: 'platform.index.audit',
    label: text('Platform Operator Audit Log'),
    description: text('Search and export instance-wide platform admin events'),
    href: () => resolve('/platform/audit'),
  },
]

export const platformSettingsLinkItems: SurfaceBuilder<'platform.settings.links'> = () => [
  {
    id: 'platform.settings.links.orgs',
    label: text('Organizations →'),
    href: () => resolve('/platform/settings/orgs'),
  },
  {
    id: 'platform.settings.links.resource-usage',
    label: text('Resource Usage →'),
    href: () => resolve('/platform/settings/resource-usage'),
  },
]

export const settingsAuditLinkItems: SurfaceBuilder<'settings.audit.links'> = () => [
  {
    id: 'settings.audit.links.access-report',
    label: text('Access Report →'),
    href: () => resolve('/settings/audit/access-report'),
  },
  {
    id: 'settings.audit.links.forwarding',
    label: text('Forwarding & Retention →'),
    href: () => resolve('/settings/audit/forwarding'),
  },
]

function statusTab(
  id: Card<'notifications.tabs'>['id'],
  status: string,
  label: string
): Card<'notifications.tabs'> {
  return {
    id,
    label: text(label),
    href: () => resolve('/notifications'),
    query: () => `?status=${status}`,
    match: (ctx) => ctx.status === status,
  }
}

export const notificationsTabItems: SurfaceBuilder<'notifications.tabs'> = () => [
  statusTab('notifications.tabs.all', 'all', 'All'),
  statusTab('notifications.tabs.unread', 'unread', 'Unread'),
  statusTab('notifications.tabs.read', 'read', 'Read'),
]
