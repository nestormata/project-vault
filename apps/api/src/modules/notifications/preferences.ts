import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { notificationPreferences } from '@project-vault/db/schema'
import {
  NOTIFICATION_ALERT_TYPES,
  DEFAULT_NOTIFICATION_CHANNELS,
  DEFAULT_NOTIFICATION_FREQUENCY,
  DEFAULT_NOTIFICATION_MIN_SEVERITY,
  type NotificationChannel,
  type NotificationFrequency,
  type NotificationSeverity,
} from '@project-vault/shared'
import type { z } from 'zod/v4'
import type { PreferenceItemSchema } from './schema.js'

type PreferenceInput = z.infer<typeof PreferenceItemSchema>

export type PreferenceOutput = {
  alertType: string
  channel: NotificationChannel
  frequency: NotificationFrequency
  minSeverity: NotificationSeverity
}

export async function getPreferences(
  orgId: string,
  userId: string,
  tx: Tx
): Promise<PreferenceOutput[]> {
  const stored = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.orgId, orgId), eq(notificationPreferences.userId, userId))
    )

  const storedKeys = new Set(stored.map((r) => `${r.alertType}:${r.channel}`))

  const result: PreferenceOutput[] = stored.map((r) => ({
    alertType: r.alertType,
    channel: r.channel as NotificationChannel,
    frequency: r.frequency as NotificationFrequency,
    minSeverity: r.minSeverity as NotificationSeverity,
  }))

  for (const alertType of NOTIFICATION_ALERT_TYPES) {
    for (const channel of DEFAULT_NOTIFICATION_CHANNELS) {
      if (!storedKeys.has(`${alertType}:${channel}`)) {
        result.push({
          alertType,
          channel,
          frequency: DEFAULT_NOTIFICATION_FREQUENCY,
          minSeverity: DEFAULT_NOTIFICATION_MIN_SEVERITY,
        })
      }
    }
  }

  return result.sort(
    (a, b) => a.alertType.localeCompare(b.alertType) || a.channel.localeCompare(b.channel)
  )
}

export async function putPreferences(
  orgId: string,
  userId: string,
  items: PreferenceInput[],
  tx: Tx
): Promise<PreferenceOutput[]> {
  await tx
    .delete(notificationPreferences)
    .where(
      and(eq(notificationPreferences.orgId, orgId), eq(notificationPreferences.userId, userId))
    )

  const toInsert = items.filter((item) => item.channel !== 'none')
  if (toInsert.length > 0) {
    await tx.insert(notificationPreferences).values(
      toInsert.map((item) => ({
        orgId,
        userId,
        alertType: item.alertType,
        channel: item.channel as NotificationChannel,
        frequency: item.frequency,
        minSeverity: item.minSeverity,
      }))
    )
  }

  return getPreferences(orgId, userId, tx)
}

export async function patchPreferences(
  orgId: string,
  userId: string,
  items: PreferenceInput[],
  tx: Tx
): Promise<PreferenceOutput[]> {
  for (const item of items) {
    if (item.channel === 'none') {
      await tx
        .delete(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.orgId, orgId),
            eq(notificationPreferences.userId, userId),
            eq(notificationPreferences.alertType, item.alertType)
          )
        )
    } else {
      await tx
        .insert(notificationPreferences)
        .values({
          orgId,
          userId,
          alertType: item.alertType,
          channel: item.channel as NotificationChannel,
          frequency: item.frequency,
          minSeverity: item.minSeverity,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.orgId,
            notificationPreferences.userId,
            notificationPreferences.alertType,
            notificationPreferences.channel,
          ],
          set: {
            frequency: item.frequency,
            minSeverity: item.minSeverity,
            updatedAt: new Date(),
          },
        })
    }
  }

  return getPreferences(orgId, userId, tx)
}
