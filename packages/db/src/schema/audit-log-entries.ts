import { pgTable, uuid, text, timestamp, jsonb, integer, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { userIdentityTokens } from './user-identity-tokens.js'

// IMMUTABLE: append-only, no updates permitted
export const auditLogEntries = pgTable(
  'audit_log_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped(),
    // FK to projects(id) intentionally deferred — projects table created in Story 2.1.
    // Story 2.1 MUST add: ALTER TABLE audit_log_entries ADD CONSTRAINT fk_audit_project
    //   FOREIGN KEY (project_id) REFERENCES projects(id);
    // Until then, project_id accepts any UUID without referential validation.
    projectId: uuid('project_id'),
    actorTokenId: uuid('actor_token_id').references(() => userIdentityTokens.id),
    actorType: text('actor_type').notNull(),
    eventType: text('event_type').notNull(),
    resourceId: uuid('resource_id'),
    resourceType: text('resource_type'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    payload: jsonb('payload').notNull().default({}),
    keyVersion: integer('key_version').notNull(),
    hmac: text('hmac').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NO updated_at: immutable table
  },
  (t) => ({
    orgCreatedIdx: index('idx_audit_log_entries_org_created').on(t.orgId, t.createdAt.desc()),
    projectIdx: index('idx_audit_log_entries_project').on(t.projectId, t.createdAt.desc()),
    eventTypeIdx: index('idx_audit_log_entries_event_type').on(t.eventType, t.createdAt.desc()),
    resourceIdx: index('idx_audit_log_entries_resource').on(t.resourceId, t.createdAt.desc()),
    actorTypeCheck: check(
      'audit_log_entries_actor_type_check',
      sql`${t.actorType} IN ('human','machine_user','system')`
    ),
  })
)
