import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { withOrg } from '../index.js'
import { credentials, projects } from '../schema/index.js'
import { createTestUser, deleteTestUser, insertTestProject, withTestOrg } from '../test-helpers.js'
import { createCredentialTestProject } from './credential-test-helpers.js'

/**
 * Story 1.13 AC-T4 code-review follow-up: the original `0043_normalize_tag_case.sql` draft's
 * `WHERE "tags" <> (SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), ...))` compared the *stored*
 * array (whatever order it happens to be in) against the *aggregated* array, whose order is
 * determined by `DISTINCT`'s internal sort (alphabetical for text) — never the original insertion
 * order. A row that is already fully lowercase and duplicate-free, but was stored in a
 * non-alphabetical order (e.g. `['staging', 'prod']`), was therefore NOT actually a no-op match for
 * that WHERE clause, even though AC-T4 explicitly requires "already-compliant rows have their
 * updated_at and all other columns completely untouched." These tests reproduce the migration's
 * corrected, order-independent SET/WHERE expressions (scoped to a single test row via `id = ...`,
 * so they never touch unrelated data) and assert the compliant-rows-untouched contract AC-T4
 * actually promises.
 */
function normalizedTagsExpr(column: 'tags') {
  return sql.raw(
    `(SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb) FROM jsonb_array_elements_text(${column}) AS elem)`
  )
}

function needsNormalizingExpr(column: 'tags') {
  return sql.raw(
    `(EXISTS (SELECT 1 FROM jsonb_array_elements_text(${column}) AS elem WHERE elem <> lower(elem))` +
      ` OR (SELECT count(*) FROM jsonb_array_elements_text(${column}) AS elem)` +
      ` <> (SELECT count(DISTINCT lower(elem)) FROM jsonb_array_elements_text(${column}) AS elem))`
  )
}

describe('migration 0043 tag-case backfill WHERE clause (AC-T4)', () => {
  it('does not touch a credentials row whose tags are already lowercase+deduped but not alphabetically ordered', async () => {
    const userId = await createTestUser('migration-0043-cred-order')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0043-cred-order')
        const [inserted] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentials)
            .values({
              orgId,
              projectId,
              name: 'cred-0043-order',
              createdBy: userId,
              tags: ['staging', 'prod'],
            })
            .returning({ id: credentials.id, updatedAt: credentials.updatedAt })
        )
        if (!inserted) throw new Error('expected test credential to be inserted')

        await withOrg(orgId, (tx) =>
          tx.execute(sql`
            UPDATE credentials
            SET tags = ${normalizedTagsExpr('tags')}
            WHERE id = ${inserted.id} AND ${needsNormalizingExpr('tags')}
          `)
        )

        const [after] = await withOrg(orgId, (tx) =>
          tx
            .select({ tags: credentials.tags, updatedAt: credentials.updatedAt })
            .from(credentials)
            .where(sql`${credentials.id} = ${inserted.id}`)
        )

        expect(after?.tags).toEqual(['staging', 'prod'])
        expect(after?.updatedAt.getTime()).toBe(inserted.updatedAt.getTime())
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('does not touch a projects row whose tags are already lowercase+deduped but not alphabetically ordered', async () => {
    const userId = await createTestUser('migration-0043-proj-order')
    try {
      await withTestOrg(async ({ orgId }) => {
        const inserted = await insertTestProject(orgId, {
          userId,
          slug: 'proj-0043-tags-order',
          tags: ['staging', 'prod'],
        })

        await withOrg(orgId, (tx) =>
          tx.execute(sql`
            UPDATE projects
            SET tags = ${normalizedTagsExpr('tags')}
            WHERE id = ${inserted.id} AND ${needsNormalizingExpr('tags')}
          `)
        )

        const [after] = await withOrg(orgId, (tx) =>
          tx
            .select({ tags: projects.tags, updatedAt: projects.updatedAt })
            .from(projects)
            .where(sql`${projects.id} = ${inserted.id}`)
        )

        expect(after?.tags).toEqual(['staging', 'prod'])
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('still normalizes a genuinely mixed-case/duplicate credentials row (regression)', async () => {
    const userId = await createTestUser('migration-0043-cred-fix')
    try {
      await withTestOrg(async ({ orgId }) => {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0043-cred-fix')
        const [inserted] = await withOrg(orgId, (tx) =>
          tx
            .insert(credentials)
            .values({
              orgId,
              projectId,
              name: 'cred-0043-fix',
              createdBy: userId,
              tags: ['Prod', 'prod', 'Staging'],
            })
            .returning({ id: credentials.id })
        )
        if (!inserted) throw new Error('expected test credential to be inserted')

        await withOrg(orgId, (tx) =>
          tx.execute(sql`
            UPDATE credentials
            SET tags = ${normalizedTagsExpr('tags')}
            WHERE id = ${inserted.id} AND ${needsNormalizingExpr('tags')}
          `)
        )

        const [after] = await withOrg(orgId, (tx) =>
          tx
            .select({ tags: credentials.tags })
            .from(credentials)
            .where(sql`${credentials.id} = ${inserted.id}`)
        )

        expect(after?.tags).toEqual(['prod', 'staging'])
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
