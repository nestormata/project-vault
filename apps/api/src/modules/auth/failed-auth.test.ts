import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { failedAuthAttempts } from '@project-vault/db/schema'
import { recordFailedAuthAttempt } from './failed-auth.js'

const OWNER_EMAIL = 'owner@example.com'

describe('recordFailedAuthAttempt', () => {
  beforeEach(async () => {
    await getDb().delete(failedAuthAttempts)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('records normalized failed auth attempts without requiring an org context', async () => {
    await recordFailedAuthAttempt({
      userId: null,
      ipAddress: '127.0.0.1',
      attemptedEmail: ' ＯＷＮＥＲ@EXAMPLE.COM ',
      reason: 'invalid_credentials',
    })

    const [row] = await getDb()
      .select()
      .from(failedAuthAttempts)
      .orderBy(desc(failedAuthAttempts.attemptedAt))
      .limit(1)

    expect(row).toMatchObject({
      userId: null,
      ipAddress: '127.0.0.1',
      attemptedEmail: OWNER_EMAIL,
      reason: 'invalid_credentials',
    })
  })

  it('skips inserts when failed auth recording is disabled', async () => {
    vi.stubEnv('FAILED_AUTH_RECORD_ENABLED', 'false')

    await recordFailedAuthAttempt({
      userId: null,
      ipAddress: '127.0.0.1',
      attemptedEmail: OWNER_EMAIL,
      reason: 'invalid_credentials',
    })

    const rows = await getDb()
      .select({ id: failedAuthAttempts.id })
      .from(failedAuthAttempts)
      .where(eq(failedAuthAttempts.attemptedEmail, OWNER_EMAIL))

    expect(rows).toHaveLength(0)
  })
})
