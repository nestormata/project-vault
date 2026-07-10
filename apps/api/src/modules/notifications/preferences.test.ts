import { describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import {
  getPreferences,
  getPreferencesBatch,
  patchPreferences,
  putPreferences,
} from './preferences.js'

const FAILED_AUTH_ALERT = 'security.failed_auth_threshold'
const SERVICE_DOWN_ALERT = 'service.down'
const EMAIL_CHANNEL = 'email'
const CREDENTIAL_EXPIRY_ALERT = 'credential.expiry'

describe('notification preferences service', () => {
  it('returns stored value overriding default', async () => {
    const userId = await createTestUser('prefs-stored')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          patchPreferences(
            orgId,
            userId,
            [
              {
                alertType: FAILED_AUTH_ALERT,
                channel: EMAIL_CHANNEL,
                frequency: 'digest_daily',
                minSeverity: 'critical',
              },
            ],
            tx
          )
        )

        const prefs = await withOrg(orgId, (tx) => getPreferences(orgId, userId, tx))
        const emailPref = prefs.find(
          (p) => p.alertType === FAILED_AUTH_ALERT && p.channel === EMAIL_CHANNEL
        )
        expect(emailPref?.frequency).toBe('digest_daily')
        expect(emailPref?.minSeverity).toBe('critical')

        const inboxPref = prefs.find(
          (p) => p.alertType === FAILED_AUTH_ALERT && p.channel === 'inbox'
        )
        expect(inboxPref?.frequency).toBe('immediate')
        expect(inboxPref?.minSeverity).toBe('warning')
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('putPreferences replaces all stored rows', async () => {
    const userId = await createTestUser('prefs-put')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          patchPreferences(
            orgId,
            userId,
            [
              {
                alertType: SERVICE_DOWN_ALERT,
                channel: EMAIL_CHANNEL,
                frequency: 'digest_daily',
                minSeverity: 'info',
              },
            ],
            tx
          )
        )

        await withOrg(orgId, (tx) =>
          putPreferences(
            orgId,
            userId,
            [
              {
                alertType: FAILED_AUTH_ALERT,
                channel: EMAIL_CHANNEL,
                frequency: 'immediate',
                minSeverity: 'critical',
              },
            ],
            tx
          )
        )

        const prefs = await withOrg(orgId, (tx) => getPreferences(orgId, userId, tx))
        const serviceDownEmail = prefs.find(
          (p) => p.alertType === SERVICE_DOWN_ALERT && p.channel === EMAIL_CHANNEL
        )
        expect(serviceDownEmail?.frequency).toBe('immediate')
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('preferences are isolated per org', async () => {
    const userId = await createTestUser('prefs-org-iso')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withOrg(orgAId, (tx) =>
          patchPreferences(
            orgAId,
            userId,
            [
              {
                alertType: SERVICE_DOWN_ALERT,
                channel: EMAIL_CHANNEL,
                frequency: 'digest_daily',
                minSeverity: 'info',
              },
            ],
            tx
          )
        )
      })

      await withTestOrg(async ({ orgId: orgBId }) => {
        const prefs = await withOrg(orgBId, (tx) => getPreferences(orgBId, userId, tx))
        const serviceDown = prefs.find(
          (p) => p.alertType === SERVICE_DOWN_ALERT && p.channel === EMAIL_CHANNEL
        )
        expect(serviceDown?.frequency).toBe('immediate')
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('getPreferencesBatch returns default-filled entries for every requested user', async () => {
    const firstUserId = await createTestUser('prefs-batch-default-1')
    const secondUserId = await createTestUser('prefs-batch-default-2')
    try {
      await withTestOrg(async ({ orgId }) => {
        const batch = await withOrg(orgId, (tx) =>
          getPreferencesBatch(orgId, [firstUserId, secondUserId], tx)
        )

        expect(batch.size).toBe(2)
        for (const userId of [firstUserId, secondUserId]) {
          const prefs = batch.get(userId)
          expect(prefs).toBeDefined()
          expect(prefs?.length).toBeGreaterThan(0)
          expect(
            prefs?.find((p) => p.alertType === FAILED_AUTH_ALERT && p.channel === EMAIL_CHANNEL)
          ).toMatchObject({
            frequency: 'immediate',
            minSeverity: 'warning',
          })
        }
      })
    } finally {
      await deleteTestUser(firstUserId)
      await deleteTestUser(secondUserId)
    }
  })

  it('getPreferencesBatch mixes stored overrides and defaults without leaking between users', async () => {
    const overrideUserId = await createTestUser('prefs-batch-override')
    const defaultUserId = await createTestUser('prefs-batch-default')
    try {
      await withTestOrg(async ({ orgId }) => {
        await withOrg(orgId, (tx) =>
          patchPreferences(
            orgId,
            overrideUserId,
            [
              {
                alertType: CREDENTIAL_EXPIRY_ALERT,
                channel: 'email',
                frequency: 'digest_daily',
                minSeverity: 'critical',
              },
            ],
            tx
          )
        )

        const batch = await withOrg(orgId, (tx) =>
          getPreferencesBatch(orgId, [overrideUserId, defaultUserId], tx)
        )

        expect(
          batch
            .get(overrideUserId)
            ?.find((p) => p.alertType === CREDENTIAL_EXPIRY_ALERT && p.channel === 'email')
        ).toMatchObject({
          frequency: 'digest_daily',
          minSeverity: 'critical',
        })
        expect(
          batch
            .get(defaultUserId)
            ?.find((p) => p.alertType === CREDENTIAL_EXPIRY_ALERT && p.channel === 'email')
        ).toMatchObject({
          frequency: 'immediate',
          minSeverity: 'warning',
        })
      })
    } finally {
      await deleteTestUser(overrideUserId)
      await deleteTestUser(defaultUserId)
    }
  })

  it('getPreferencesBatch returns an empty map for an empty user list', async () => {
    const userId = await createTestUser('prefs-batch-empty')
    try {
      await withTestOrg(async ({ orgId }) => {
        const batch = await withOrg(orgId, (tx) => getPreferencesBatch(orgId, [], tx))
        expect(batch.size).toBe(0)
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
