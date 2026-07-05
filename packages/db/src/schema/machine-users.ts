import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

// Story 7.1 — machine user identity (FR32/FR33/FR36/FR68). See story "Key Design Decisions &
// Open Questions" D4: role lives as a direct column here rather than in project_memberships to
// avoid a high-risk schema change to a table load-bearing for Stories 2.1/4.1/4.2/4.3/4.4.
export const machineUsers = pgTable(
  'machine_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    role: text('role').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Reserved for a future deactivation endpoint (no story sets this yet — see AC-1 notes).
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index('idx_machine_users_project').on(t.projectId),
    orgIdx: index('idx_machine_users_org').on(t.orgId),
    roleCheck: check('machine_users_role_check', sql`${t.role} IN ('member','viewer')`),
    nameLenCheck: check(
      'machine_users_name_len_check',
      sql`char_length(${t.name}) BETWEEN 1 AND 128`
    ),
  })
)

export type MachineUser = typeof machineUsers.$inferSelect
export type NewMachineUser = typeof machineUsers.$inferInsert
