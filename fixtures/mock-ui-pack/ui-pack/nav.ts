// M5 (navigation customization) of the mock UI pack (Story 68.10): every operation of the nav delta
// (add, remove, hide, rename, reorder, move, replace, nest, inheritance of a new item) on PV's native
// items AND on the pack's own, on every surface a composed page renders:
//
//   primary (also the mobile nav), project, settings.index, settings.audit.links, platform.index,
//   platform.settings.links, notifications.tabs, breadcrumbs, back, auth.links, shell.brand,
//   shell.utility, account.
//
// `footer` and `error.nav` are rendered by PV files this pack replaces on purpose (M4 Footer.svelte,
// the M1 root +error.svelte), so those two surfaces are exercised by the shipped composed-nav test
// that `pv-verify` runs over this tree, not by the browser spec (the README records this).
//
// Every label carries the `Mock ` prefix so an assertion can never pass on PV's own text. Client-safe:
// no server-only import (nav renders in the browser too).
import { resolve } from '$app/paths'
import {
  defineNavDelta,
  hide,
  insert,
  move,
  relabel,
  remove,
  reorder,
  replace,
} from '@project-vault/composition-kit/nav'

export default defineNavDelta({
  primary: [
    // add: next to a native item
    insert({
      after: 'primary.projects',
      item: { id: 'mock.billing', label: 'Mock Billing', href: () => resolve('/billing') },
    }),
    // remove, hide (the route still serves), rename, move and reorder native items
    remove('primary.secrets'),
    hide('primary.health'),
    relabel('primary.settings', 'Mock Settings'),
    move('primary.dashboard', { after: 'primary.settings' }),
    reorder('primary', ['primary.notifications']),
    // nest: the pack's own two-level group (a child under the pack's own item) ...
    insert({
      parent: 'primary',
      item: {
        id: 'mock.tools',
        label: 'Mock Tools',
        children: [
          {
            id: 'mock.tools.reports',
            label: 'Mock Reports',
            children: [
              {
                id: 'mock.tools.reports.daily',
                label: 'Mock Daily',
                href: () => resolve('/billing/deep/level'),
              },
            ],
          },
        ],
      },
    }),
    // ... and a child under a NATIVE item
    insert({
      parent: 'primary.settings',
      item: { id: 'mock.settings.child', label: 'Mock Settings Child', href: () => resolve('/m4') },
    }),
    // inheritance: a later insert under the pack's group appears wherever the group appears
    insert({
      parent: 'mock.tools',
      item: { id: 'mock.tools.late', label: 'Mock Late', href: () => resolve('/billing') },
    }),
    // a hidden item of the pack's own is absent from the DOM; its route still serves
    insert({
      parent: 'primary',
      item: { id: 'mock.hidden', label: 'Mock Hidden', href: () => resolve('/billing') },
    }),
    hide('mock.hidden'),
    // an id this web-host never had: recorded and reported, never a crash
    hide('primary.mock-not-a-pv-item'),
  ],
  project: [
    insert({
      parent: 'project',
      item: {
        id: 'mock.project.billing',
        label: 'Mock Project Billing',
        href: () => resolve('/billing'),
      },
    }),
    remove('project.certificates'),
    hide('project.domains'),
    relabel('project.members', 'Mock Team'),
    reorder('project', ['project.members']),
    insert({
      parent: 'project.services',
      item: {
        id: 'mock.project.services.child',
        label: 'Mock Service Child',
        href: () => resolve('/m4'),
      },
    }),
  ],
  'settings.index': [
    hide('settings.index.sso-domains'),
    remove('settings.index.themes'),
    relabel('settings.index.users', {
      label: 'Mock Seats',
      description: () => 'Mock seats and roles',
    }),
    insert({
      after: 'settings.index.language',
      item: {
        id: 'mock.settings.card',
        label: 'Mock Card',
        description: 'Mock card description',
        href: () => resolve('/billing'),
      },
    }),
    insert({
      parent: 'settings.index.audit',
      item: {
        id: 'mock.settings.audit-card',
        label: 'Mock Audit Card',
        description: 'Mock nested card',
        href: () => resolve('/billing/deep/level'),
      },
    }),
  ],
  'settings.audit.links': [
    insert({
      parent: 'settings.audit.links',
      item: { id: 'mock.audit.link', label: 'Mock Audit Link', href: () => resolve('/billing') },
    }),
    relabel('settings.audit.links.forwarding', 'Mock Forwarding'),
  ],
  'platform.index': [
    hide('platform.index.upgrade'),
    relabel('platform.index.backups', { label: 'Mock Backups', description: 'Mock backups text' }),
    insert({
      parent: 'platform.index',
      item: {
        id: 'mock.platform.card',
        label: 'Mock Platform Card',
        description: 'Mock platform card text',
        href: () => resolve('/billing'),
      },
    }),
  ],
  'platform.settings.links': [
    insert({
      before: 'platform.settings.links.orgs',
      item: {
        id: 'mock.platform.link',
        label: 'Mock Platform Link',
        href: () => resolve('/billing'),
      },
    }),
  ],
  'notifications.tabs': [
    insert({
      parent: 'notifications.tabs',
      item: {
        id: 'mock.tab',
        label: 'Mock Tab',
        href: () => resolve('/notifications'),
        query: () => '?status=all',
        match: () => false,
      },
    }),
    relabel('notifications.tabs.read', 'Mock Read'),
    hide('notifications.tabs.unread'),
  ],
  breadcrumbs: [
    // the pack's own nodes under PV's tree; /billing/deep/level renders `<Breadcrumbs node=...>`
    insert({
      parent: 'breadcrumbs.platform',
      item: {
        id: 'mock.crumb',
        label: 'Mock Crumb',
        href: () => resolve('/billing'),
        children: [
          {
            id: 'mock.crumb.deep',
            label: 'Mock Deep Crumb',
            href: () => resolve('/billing/deep/level'),
          },
        ],
      },
    }),
    relabel('breadcrumbs.platform.settings', 'Mock System'),
  ],
  back: [relabel('back.settings.language', 'Mock Back'), hide('back.settings.security')],
  'auth.links': [
    insert({
      // a page renders one node of this surface and its descendants as sibling links, so the pack's
      // link is a child of the node the login page renders
      parent: 'auth.links.login.register',
      item: { id: 'mock.auth.help', label: 'Mock Auth Help', href: () => resolve('/billing') },
    }),
    relabel('auth.links.login.recovery', 'Mock Recover'),
  ],
  'shell.brand': [
    replace('shell.brand.home', { label: 'Mock Brand', href: () => resolve('/billing') }),
  ],
  'shell.utility': [relabel('shell.utility.notifications', 'Mock Bell')],
  account: [
    insert({
      before: 'account.sign-out',
      item: {
        id: 'mock.account.billing',
        label: 'Mock Account Billing',
        href: () => resolve('/billing'),
      },
    }),
    insert({
      parent: 'account',
      item: {
        id: 'mock.account.more',
        label: 'Mock More',
        children: [{ id: 'mock.account.more.one', label: 'Mock One', href: () => resolve('/m4') }],
      },
    }),
  ],
})
