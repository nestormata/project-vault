import { and, eq, inArray, ne } from 'drizzle-orm'
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
type StoredNotificationChannel = NotificationChannel | 'none'

export type PreferenceOutput = {
  alertType: string
  channel: StoredNotificationChannel
  frequency: NotificationFrequency
  minSeverity: NotificationSeverity
}

function fillDefaultPreferences(stored: PreferenceOutput[]): PreferenceOutput[] {
  const storedKeys = new Set(stored.map((r) => `${r.alertType}:${r.channel}`))
  const optedOutAlertTypes = new Set(
    stored.filter((row) => row.channel === 'none').map((row) => row.alertType)
  )
  const result: PreferenceOutput[] = [...stored]

  for (const alertType of NOTIFICATION_ALERT_TYPES) {
    if (optedOutAlertTypes.has(alertType)) continue
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

function toPreferenceOutput(
  rows: Array<{
    alertType: string
    channel: string
    frequency: string
    minSeverity: string
  }>
): PreferenceOutput[] {
  return rows.map((r) => ({
    alertType: r.alertType,
    channel: r.channel as StoredNotificationChannel,
    frequency: r.frequency as NotificationFrequency,
    minSeverity: r.minSeverity as NotificationSeverity,
  }))
}

async function upsertPreference(
  orgId: string,
  userId: string,
  item: PreferenceInput,
  tx: Tx
): Promise<void> {
  await tx
    .insert(notificationPreferences)
    .values({
      orgId,
      userId,
      alertType: item.alertType,
      channel: item.channel,
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

  return fillDefaultPreferences(toPreferenceOutput(stored))
}

export async function getPreferencesBatch(
  orgId: string,
  userIds: string[],
  tx: Tx
): Promise<Map<string, PreferenceOutput[]>> {
  if (userIds.length === 0) return new Map()

  const stored = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.orgId, orgId),
        inArray(notificationPreferences.userId, userIds)
      )
    )

  const storedByUserId = new Map<string, PreferenceOutput[]>()
  for (const row of stored) {
    const prefs = storedByUserId.get(row.userId) ?? []
    prefs.push(...toPreferenceOutput([row]))
    storedByUserId.set(row.userId, prefs)
  }

  const result = new Map<string, PreferenceOutput[]>()
  for (const userId of userIds) {
    result.set(userId, fillDefaultPreferences(storedByUserId.get(userId) ?? []))
  }
  return result
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

  if (items.length > 0) {
    await tx.insert(notificationPreferences).values(
      items.map((item) => ({
        orgId,
        userId,
        alertType: item.alertType,
        channel: item.channel,
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
            eq(notificationPreferences.alertType, item.alertType),
            ne(notificationPreferences.channel, 'none')
          )
        )
      await upsertPreference(orgId, userId, item, tx)
      continue
    }

    await tx
      .delete(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.orgId, orgId),
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.alertType, item.alertType),
          eq(notificationPreferences.channel, 'none')
        )
      )
    await upsertPreference(orgId, userId, item, tx)
  }

  return getPreferences(orgId, userId, tx)
}
