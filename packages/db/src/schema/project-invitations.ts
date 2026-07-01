import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export const projectInvitations = pgTable(
  'project_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleToAssign: text('role_to_assign').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_project_invitations_token_hash').on(t.tokenHash),
    projectPendingIdx: index('idx_project_invitations_project_id').on(t.projectId),
    orgIdIdx: index('idx_project_invitations_org_id').on(t.orgId),
    roleCheck: check(
      'project_invitations_role_check',
      // NOTE: no 'owner' — ownership transfer is Story 4.2 (AC-E4c), not an invite target
      sql`${t.roleToAssign} IN ('admin','member','viewer')`
    ),
  })
)

export type ProjectInvitation = typeof projectInvitations.$inferSelect
export type NewProjectInvitation = typeof projectInvitations.$inferInsert
