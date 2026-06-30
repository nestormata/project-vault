import { eq, and, inArray } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { notificationQueue, orgMemberships, users } from '@project-vault/db/schema'
import type { BossService } from '../lib/boss.js'

export type NotificationTemplate = {
  templateId: string
  payload: Record<string, unknown>
}

export type NotificationQueueIds = {
  emailIds: Array<{ id: string; orgId: string }>
  slackId?: { id: string; orgId: string }
}

const NOTIFICATION_JOB_OPTIONS = {
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 60,
} as const

type CreateEntriesOptions = {
  orgId: string
  template: NotificationTemplate
  tx: Tx
}

export async function createOrgAdminNotificationEntries(
  options: CreateEntriesOptions
): Promise<NotificationQueueIds> {
  const { orgId, template, tx } = options

  const recipients = await tx
    .select({ userId: orgMemberships.userId, email: users.email })
    .from(orgMemberships)
    .innerJoin(users, eq(orgMemberships.userId, users.id))
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, 'active'),
        inArray(orgMemberships.role, ['owner', 'admin'])
      )
    )

  if (recipients.length === 0) {
    process.stderr.write(
      `${JSON.stringify({
        eventType: 'notification.dispatch.no_recipients',
        orgId,
        templateId: template.templateId,
      })}\n`
    )
  }

  const emailEntries =
    recipients.length === 0
      ? []
      : await tx
          .insert(notificationQueue)
          .values(
            recipients.map((r) => ({
              orgId,
              recipientUserId: r.userId,
              channel: 'email' as const,
              templateId: template.templateId,
              payload: template.payload,
              status: 'pending' as const,
            }))
          )
          .returning({ id: notificationQueue.id })

  const [slackEntry] = await tx
    .insert(notificationQueue)
    .values({
      orgId,
      recipientUserId: null,
      channel: 'slack' as const,
      templateId: template.templateId,
      payload: template.payload,
      status: 'pending' as const,
    })
    .returning({ id: notificationQueue.id })

  return {
    emailIds: emailEntries.filter((entry) => entry.id).map((entry) => ({ id: entry.id, orgId })),
    slackId: slackEntry?.id ? { id: slackEntry.id, orgId } : undefined,
  }
}

export async function sendNotificationJobs(
  boss: BossService,
  ids: NotificationQueueIds
): Promise<void> {
  if (!boss.isStarted()) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'notification.dispatch.boss_not_started', ids })}\n`
    )
    return
  }

  for (const entry of ids.emailIds) {
    await boss.send(
      'notification:email',
      { notificationQueueId: entry.id, orgId: entry.orgId },
      NOTIFICATION_JOB_OPTIONS
    )
  }
  if (ids.slackId) {
    await boss.send(
      'notification:slack',
      { notificationQueueId: ids.slackId.id, orgId: ids.slackId.orgId },
      NOTIFICATION_JOB_OPTIONS
    )
  }
}

type DispatchOptions = CreateEntriesOptions & {
  boss: BossService
}

export async function dispatchOrgAdminNotification(options: DispatchOptions): Promise<void> {
  const ids = await createOrgAdminNotificationEntries(options)
  await sendNotificationJobs(options.boss, ids)
}

export async function enqueueSecurityAlertNotification(opts: {
  orgId: string
  templateId: string
  payload: Record<string, unknown>
  tx: Tx
}): Promise<NotificationQueueIds> {
  return createOrgAdminNotificationEntries({
    orgId: opts.orgId,
    template: { templateId: opts.templateId, payload: opts.payload },
    tx: opts.tx,
  })
}
