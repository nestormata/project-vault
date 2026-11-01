import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

// Story 7.1 — machine user identity (FR32/FR33/FR36/FR68). Story decision D4: role lives as a
// direct column here rather than in project_memberships to avoid a high-risk schema change to a
// table load-bearing for Stories 2.1/4.1/4.2/4.3/4.4.
//
// Story 73.9 (D1) — a row is one of two principals. An admin-provisioned row belongs to a project
// and authenticates with API keys. A host-managed row (`host_managed = true`) is created by the
// host for an extension's credential-sharing writes: org-scoped (no project), no human creator, and
// never holds a key, so it cannot authenticate, expire or go dormant.
export const machineUsers = pgTable(
  'machine_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    role: text('role').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set by `POST /machine-users/:id/deactivate` (Story 8-6) for admin-provisioned rows. A
    // deactivated host-managed row is never resurrected (Story 73.9 D6).
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    hostManaged: boolean('host_managed').notNull().default(false),
  },
  (t) => ({
    projectIdx: index('idx_machine_users_project').on(t.projectId),
    orgIdx: index('idx_machine_users_org').on(t.orgId),
    roleCheck: check('machine_users_role_check', sql`${t.role} IN ('member','viewer')`),
    nameLenCheck: check(
      'machine_users_name_len_check',
      sql`char_length(${t.name}) BETWEEN 1 AND 128`
    ),
    hostManagedShapeCheck: check(
      'machine_users_host_managed_shape_check',
      sql`(${t.hostManaged} AND ${t.projectId} IS NULL AND ${t.createdBy} IS NULL) OR (NOT ${t.hostManaged} AND ${t.projectId} IS NOT NULL)`
    ),
    hostManagedNameUnique: uniqueIndex('uq_machine_users_host_managed_org_name')
      .on(t.orgId, t.name)
      .where(sql`${t.hostManaged}`),
  })
)

export type MachineUser = typeof machineUsers.$inferSelect
export type NewMachineUser = typeof machineUsers.$inferInsert
