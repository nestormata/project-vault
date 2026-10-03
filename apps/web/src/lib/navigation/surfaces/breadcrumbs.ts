// Story 68.7 (S13): breadcrumbs as one tree. A page renders the path from the root to its own node
// (`<Breadcrumbs node="…">`); the last crumb is text. CM's M2 pages render PV's breadcrumbs the
// same way after inserting their own nodes (design rule 8).
import { resolve } from '$app/paths'
import type { SurfaceBuilder } from './define.js'
import { text } from './define.js'

export const breadcrumbItems: SurfaceBuilder<'breadcrumbs'> = () => [
  {
    id: 'breadcrumbs.platform',
    label: text('Platform Admin'),
    href: () => resolve('/platform'),
    children: [
      {
        id: 'breadcrumbs.platform.settings',
        label: text('System Settings'),
        href: () => resolve('/platform/settings'),
        children: [
          {
            id: 'breadcrumbs.platform.settings.orgs',
            label: text('Organizations'),
            href: () => resolve('/platform/settings/orgs'),
          },
          {
            id: 'breadcrumbs.platform.settings.resource-usage',
            label: text('Resource Usage'),
            href: () => resolve('/platform/settings/resource-usage'),
          },
        ],
      },
      {
        id: 'breadcrumbs.platform.backups',
        label: text('Backups'),
        href: () => resolve('/platform/backups'),
      },
      {
        id: 'breadcrumbs.platform.upgrade',
        label: text('Version & Upgrade'),
        href: () => resolve('/platform/upgrade'),
      },
      {
        id: 'breadcrumbs.platform.audit',
        label: text('Platform Operator Audit Log'),
        href: () => resolve('/platform/audit'),
      },
    ],
  },
]
