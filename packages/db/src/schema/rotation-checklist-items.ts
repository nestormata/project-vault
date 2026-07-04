import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { rotations } from './rotations.js'
import { credentialDependencies } from './credential-dependencies.js'

// One row per dependent system snapshotted at rotation-initiation time. `status` CHECK lists
// the full Story 5.2 state machine now (5.1 only ever writes 'unconfirmed') for the same
// reason as rotations.status (see AC-1).
export const rotationChecklistItems = pgTable(
  'rotation_checklist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    rotationId: uuid('rotation_id')
      .notNull()
      .references(() => rotations.id, { onDelete: 'cascade' }),
    // 'set null' (not restrict/cascade): Story 2.4 never hard-deletes a dependency, so this FK
    // should never actually go null in practice — but if it ever did, the systemName snapshot
    // below preserves checklist-item history independent of the source dependency row.
    dependencyId: uuid('dependency_id').references(() => credentialDependencies.id, {
      onDelete: 'set null',
    }),
    // Snapshot, NOT a live join — Story 2.4's dependency systemName could change after this
    // rotation completes; the checklist item must show what it was AT ROTATION TIME.
    systemName: text('system_name').notNull(),
    status: text('status').notNull().default('unconfirmed'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One checklist item per (rotation, dependency) pair — prevents double-generation if
    // checklist-creation logic is ever accidentally invoked twice for the same rotation.
    rotationDependencyUnique: uniqueIndex('idx_rotation_checklist_items_rotation_dependency').on(
      t.rotationId,
      t.dependencyId
    ),
    rotationIdx: index('idx_rotation_checklist_items_rotation').on(t.rotationId),
    orgIdx: index('idx_rotation_checklist_items_org').on(t.orgId),
    statusCheck: check(
      'rotation_checklist_items_status_check',
      sql`${t.status} IN ('unconfirmed','confirmed','failed','max_retries_exceeded')`
    ),
  })
)
