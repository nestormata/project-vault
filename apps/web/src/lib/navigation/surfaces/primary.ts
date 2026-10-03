// Story 68.7 (S1): the primary nav, also the mobile nav (same data, `mobileLabel`). Labels resolve
// per call (Story 28.4: `m.*()` read at render time, never at module load).
import { resolve } from '$app/paths'
import { m } from '$lib/paraglide/messages.js'
import SearchGlyph from '../SearchGlyph.svelte'
import type { SurfaceBuilder } from './define.js'
import { text } from './define.js'

export const primaryItems: SurfaceBuilder<'primary'> = () => [
  {
    id: 'primary.search',
    kind: 'action',
    label: text('Search'),
    title: text('Search (⌘K)'),
    icon: SearchGlyph,
    shortcut: '⌘K',
    onSelect: (ctx) => ctx.search?.(),
  },
  {
    id: 'primary.dashboard',
    label: () => m.nav_dashboard(),
    mobileLabel: () => m.nav_dashboard(),
    href: () => resolve('/dashboard'),
  },
  {
    id: 'primary.projects',
    label: () => m.nav_projects(),
    mobileLabel: () => m.nav_projects(),
    href: () => resolve('/projects'),
  },
  {
    id: 'primary.secrets',
    label: () => m.nav_secrets(),
    mobileLabel: () => m.nav_secrets(),
    href: () => resolve('/credentials'),
  },
  {
    id: 'primary.notifications',
    label: () => m.nav_notifications(),
    mobileLabel: () => m.nav_notifications(),
    href: () => resolve('/notifications'),
  },
  {
    id: 'primary.health',
    label: () => m.nav_health(),
    mobileLabel: () => m.nav_health(),
    href: () => resolve('/health'),
  },
  {
    id: 'primary.settings',
    label: () => m.nav_settings(),
    mobileLabel: () => m.nav_settings(),
    href: () => resolve('/settings'),
  },
  {
    id: 'primary.platform',
    label: () => m.nav_platform_admin(),
    mobileLabel: () => m.nav_platform_admin_mobile(),
    href: () => resolve('/platform'),
    when: (ctx) => ctx.user.isPlatformOperator,
  },
  {
    // Story 25.1 AC5's generic ui-panel entry (frozen panel era), carried over as a PV-native item
    // with the same label, href, position and condition (Q2b): CM can hide or move it like any
    // other native item.
    id: 'primary.extension-panel',
    label: () => m.nav_extension(),
    mobileLabel: () => m.nav_extension(),
    href: () =>
      resolve('/(app)/extensions/panels/[slot]/[...subpath]', {
        slot: 'group',
        subpath: '',
      }),
    when: (ctx) => ctx.hasUiPanelExtension,
  },
]
