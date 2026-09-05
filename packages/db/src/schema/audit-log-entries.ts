import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
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
    // Story 13.3 — field-level reveal audit (FR96/FR112): which field key(s) were revealed by a
    // CREDENTIAL_VALUE_REVEALED event, as a first-class queryable/indexable column — separate from
    // `payload`'s per-event-type shape. Nullable: NULL for a legacy/non-reveal event; populated only
    // on a completed reveal.
    revealedFields: text('revealed_fields').array(),
    keyVersion: integer('key_version').notNull(),
    hmac: text('hmac').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Story 1.25 (HIGH finding, chain-link audit HMACs): the previous row's `hmac` (per-org
    // chain), NULL only for a chain's true genesis row (the lowest chain_seq for that org).
    // Never rewritten after insert (immutability holds for this column too).
    previousEntryHmac: text('previous_entry_hmac'),
    // Story 1.25: true insertion-order sequence — NOT createdAt (see platform-audit-events.ts's
    // identical column for why createdAt is unsafe as a chain-ordering key for its sibling
    // table; audit_log_entries has no such drain feature today, but this story deliberately
    // uses one ordering convention across both tables — see Dev Notes "Row ordering" section of
    // story 1-25).
    chainSeq: bigint('chain_seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    // NO updated_at: immutable table
  },
  (t) => ({
    orgCreatedIdx: index('idx_audit_log_entries_org_created').on(t.orgId, t.createdAt.desc()),
    projectIdx: index('idx_audit_log_entries_project').on(t.projectId, t.createdAt.desc()),
    eventTypeIdx: index('idx_audit_log_entries_event_type').on(t.eventType, t.createdAt.desc()),
    resourceIdx: index('idx_audit_log_entries_resource').on(t.resourceId, t.createdAt.desc()),
    // D5 (Story 8.2) — epics.md's literal AC requires an (actor_id, timestamp)-shaped index;
    // this codebase's equivalent column is actor_token_id, and it was previously unindexed on
    // its own (only reachable as a prefix of the composite orgActorEventIdx below, which isn't
    // useful for an actorId-only filter with no orgId/eventType narrowing).
    actorTokenIdx: index('idx_audit_log_entries_actor_token').on(
      t.actorTokenId,
      t.createdAt.desc()
    ),
    // Story 6.2 (ADR-6.2-06, adversarial-review finding 16): check-anomalous-access.ts runs a
    // windowed GROUP BY (org_id, actor_token_id) query every 60 seconds forever against this
    // ever-growing table — a covering index avoids the "missing index on a forever-running
    // query" slow-burn production issue AC 8 already guards against for service_endpoints.
    orgActorEventIdx: index('idx_audit_log_entries_org_actor_event').on(
      t.orgId,
      t.actorTokenId,
      t.eventType,
      t.createdAt
    ),
    // Story 23.8 AC-8: widened to add 'extension' (an extension-authored row via
    // writeExtensionAuditEntry()). Postgres cannot widen a CHECK constraint in place — see
    // migration 0078's DROP CONSTRAINT/ADD CONSTRAINT pair (same reviewed pattern as 0047/0050).
    actorTypeCheck: check(
      'audit_log_entries_actor_type_check',
      sql`${t.actorType} IN ('human','machine_user','system','extension')`
    ),
    // Story 1.25 AC-1: chain_seq must be unique (a GENERATED ALWAYS AS IDENTITY column is not
    // implicitly unique in Postgres unless it's the primary key). Also serves as the ordering
    // index for verify.ts's per-org chain walk (WHERE org_id = :orgId ORDER BY chain_seq).
    chainSeqUniqueIdx: uniqueIndex('idx_audit_log_entries_chain_seq').on(t.chainSeq),
    orgChainSeqIdx: index('idx_audit_log_entries_org_chain_seq').on(t.orgId, t.chainSeq),
  })
)
