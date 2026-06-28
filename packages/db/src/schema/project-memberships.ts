import { sql } from 'drizzle-orm'
import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export const projectMemberships = pgTable(
  'project_memberships',
  {
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.userId] }),
    roleCheck: check(
      'project_memberships_role_check',
      sql`${t.role} IN ('owner','admin','member','viewer')`
    ),
  })
)
