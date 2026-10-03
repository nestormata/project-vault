// Story 68.7 AC-1: every surface's builder, by surface id (the registry test ties this map to
// `NAV_SURFACES` both ways).
import type { NavContexts, NavSurfaceId } from '../types.js'
import { breadcrumbItems } from './breadcrumbs.js'
import type { PvItem, SurfaceBuilder } from './define.js'
import {
  notificationsTabItems,
  platformIndexItems,
  platformSettingsLinkItems,
  settingsAuditLinkItems,
  settingsIndexItems,
} from './indexes.js'
import { primaryItems } from './primary.js'
import { projectItems } from './project.js'
import {
  accountItems,
  footerItems,
  shellBrandItems,
  shellMfaBannerItems,
  shellUtilityItems,
} from './shell.js'
import { authLinkItems, backItems, errorNavItems } from './wayfinding.js'

export const SURFACE_ITEMS: { readonly [S in NavSurfaceId]: SurfaceBuilder<S> } = {
  primary: primaryItems,
  project: projectItems,
  'shell.brand': shellBrandItems,
  'shell.utility': shellUtilityItems,
  'shell.mfa-banner': shellMfaBannerItems,
  account: accountItems,
  footer: footerItems,
  'settings.index': settingsIndexItems,
  'platform.index': platformIndexItems,
  'platform.settings.links': platformSettingsLinkItems,
  'settings.audit.links': settingsAuditLinkItems,
  'notifications.tabs': notificationsTabItems,
  breadcrumbs: breadcrumbItems,
  back: backItems,
  'error.nav': errorNavItems,
  'auth.links': authLinkItems,
}

/** PV's full tree for a surface (a fresh copy on every call). */
export function surfaceItems<S extends NavSurfaceId>(surface: S): PvItem<NavContexts[S]>[] {
  const builder: SurfaceBuilder<S> = Object.getOwnPropertyDescriptor(SURFACE_ITEMS, surface)?.value
  return builder()
}
