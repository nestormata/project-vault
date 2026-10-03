// Story 68.7 AC-16: a CentralizeMe-shaped delta exercising every operation on several surfaces (the
// apps/web twin of the composition kit's mini-pack `nav.ts`, written with PV's own types: PV never
// imports the kit). Used by the shipped composed-nav test's second case.
import { resolve } from '$app/paths'
import TestIcon from './TestIcon.svelte'
import type { NavDelta } from '../types.js'

const billing = () => resolve('/projects')

export const cmDelta: NavDelta = {
  primary: [
    {
      op: 'insert',
      after: 'primary.projects',
      item: { id: 'cm.billing', label: 'Billing', href: billing },
    },
    {
      op: 'insert',
      parent: 'primary',
      item: { id: 'cm.ops', label: () => 'Ops', icon: TestIcon, children: [] },
    },
    { op: 'move', id: 'primary.health', parent: 'cm.ops' },
    { op: 'relabel', id: 'primary.secrets', label: () => 'Vault' },
    { op: 'reorder', parent: 'primary', ids: ['primary.projects', 'primary.dashboard'] },
    { op: 'hide', id: 'primary.extension-panel' },
    { op: 'remove', id: 'cm.not-there' },
    {
      op: 'insert',
      parent: 'primary.settings',
      item: {
        id: 'cm.deep',
        label: 'Deep',
        children: [
          {
            id: 'cm.deep.a',
            label: 'A',
            children: [{ id: 'cm.deep.b', label: 'B', href: billing }],
          },
        ],
      },
    },
  ],
  project: [
    {
      op: 'insert',
      parent: 'project',
      item: {
        id: 'cm.project-billing',
        label: 'Billing',
        href: (ctx) => resolve(`/projects/${ctx.projectId}/members`),
        when: (ctx) => ctx.orgRole === 'owner',
      },
    },
  ],
  'shell.brand': [
    {
      op: 'replace',
      id: 'shell.brand.home',
      item: { label: 'CentralizeMe', href: () => resolve('/') },
    },
  ],
  account: [
    {
      op: 'insert',
      before: 'account.sign-out',
      item: { id: 'cm.account.billing', label: 'Billing', href: billing },
    },
  ],
  'settings.index': [
    { op: 'relabel', id: 'settings.index.users', label: { description: () => 'Seats and roles' } },
    { op: 'hide', id: 'settings.index.sso-domains' },
  ],
  footer: [
    {
      op: 'insert',
      parent: 'footer',
      item: {
        id: 'cm.status',
        kind: 'external',
        label: 'Status',
        href: () => 'https://status.example.com',
      },
    },
  ],
  breadcrumbs: [
    {
      op: 'insert',
      parent: 'breadcrumbs.platform',
      item: { id: 'cm.reports', label: 'Reports', href: billing },
    },
  ],
  back: [{ op: 'relabel', id: 'back.project.service', label: 'Back to all services' }],
}
