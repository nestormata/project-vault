import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  date,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations.js'

/**
 * One row per org (D3/D9). `orgId` is the primary key — `PUT /audit/forwarding` upserts this
 * row wholesale (switching `type` clears the fields belonging to the previous type, AC-17).
 * Not built with `orgScoped()` because that helper doesn't support a PK column.
 */
export const auditForwardingConfig = pgTable(
  'audit_forwarding_config',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),

    // Webhook fields (D3/D4)
    webhookUrl: text('webhook_url'),
    webhookSecretEncrypted: jsonb('webhook_secret_encrypted'),
    lastForwardedCreatedAt: timestamp('last_forwarded_created_at', { withTimezone: true }),
    lastForwardedId: uuid('last_forwarded_id'),
    consecutiveFailureCount: integer('consecutive_failure_count').notNull().default(0),

    // S3/Minio fields (D9)
    s3Bucket: text('s3_bucket'),
    s3Prefix: text('s3_prefix'),
    s3Region: text('s3_region'),
    s3AccessKeyId: text('s3_access_key_id'),
    s3SecretAccessKeyEncrypted: jsonb('s3_secret_access_key_encrypted'),
    s3Endpoint: text('s3_endpoint'),
    s3LastForwardedDate: date('s3_last_forwarded_date'),
    s3ConsecutiveFailureCount: integer('s3_consecutive_failure_count').notNull().default(0),

    configuredAt: timestamp('configured_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    typeCheck: check('audit_forwarding_config_type_check', sql`${t.type} IN ('webhook','s3')`),
  })
)

export type AuditForwardingConfig = typeof auditForwardingConfig.$inferSelect
export type NewAuditForwardingConfig = typeof auditForwardingConfig.$inferInsert
