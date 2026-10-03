// Story 68.7 (M5): the mini pack's nav delta, using every operation on several surfaces. The
// integration job asserts each effect on the built server's HTML; Story 68-10 reuses this file for
// the M5 row of the mock-ui-pack e2e. Client-safe: no server-only import.
import { resolve } from '$app/paths'
import { getLocale } from '$lib/paraglide/runtime.js'
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
import CmIcon from './nav/CmIcon.svelte'

/** CM's own i18n reads PV's locale (decision 7): a relabel that follows a locale switch. */
const healthLabel = () => (getLocale() === 'es' ? 'Salud CM' : 'Health CM')

export default defineNavDelta({
  primary: [
    insert({
      after: 'primary.projects',
      item: {
        id: 'cm.billing',
        label: 'CM Billing',
        href: () => resolve('/billing'),
        icon: CmIcon,
      },
    }),
    insert({
      before: 'primary.dashboard',
      item: { id: 'cm.home', label: 'CM Home', href: () => resolve('/m4') },
    }),
    insert({
      parent: 'primary',
      item: {
        id: 'cm.ops',
        label: 'CM Ops',
        children: [
          {
            id: 'cm.ops.reports',
            label: 'CM Reports',
            children: [
              {
                id: 'cm.ops.reports.daily',
                label: 'CM Daily',
                href: () => resolve('/billing/export'),
              },
            ],
          },
        ],
      },
    }),
    move('primary.notifications', { parent: 'cm.ops' }),
    relabel('primary.health', healthLabel),
    reorder('primary', ['cm.home', 'primary.projects']),
    insert({
      parent: 'primary',
      item: {
        id: 'cm.owners-only',
        label: 'CM Owners',
        href: () => resolve('/billing'),
        when: (ctx) => ctx.user.orgRole === 'owner',
      },
    }),
    hide('primary.not-a-pv-item'),
    insert({
      parent: 'primary',
      item: {
        id: 'cm.hidden-billing',
        label: 'CM Hidden Billing',
        href: () => resolve('/billing'),
      },
    }),
    hide('cm.hidden-billing'),
  ],
  project: [
    insert({
      parent: 'project',
      item: {
        id: 'cm.project-billing',
        label: 'CM Project Billing',
        href: (ctx) => resolve(`/projects/${ctx.projectId}/members`),
      },
    }),
    remove('project.status-page'),
  ],
  'settings.index': [
    hide('settings.index.sso-domains'),
    relabel('settings.index.users', { label: 'CM Seats', description: () => 'CM seats and roles' }),
  ],
  'shell.brand': [replace('shell.brand.home', { label: 'CM Brand', href: () => resolve('/m4') })],
  account: [
    insert({
      before: 'account.sign-out',
      item: {
        id: 'cm.account.billing',
        label: 'CM Account Billing',
        href: () => resolve('/billing'),
      },
    }),
  ],
})
