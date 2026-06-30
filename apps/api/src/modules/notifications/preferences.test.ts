import { describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { withTestOrg, createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import { getPreferences, patchPreferences, putPreferences } from './preferences.js'

const FAILED_AUTH_ALERT = 'security.failed_auth_threshold'
const SERVICE_DOWN_ALERT = 'service.down'
const EMAIL_CHANNEL = 'email'

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
})
