import type { Tx } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import type { NotificationSeverity } from '@project-vault/shared'
import { getPreferences, type PreferenceOutput } from '../modules/notifications/preferences.js'
import { resolveRoutingRecipients } from '../modules/notifications/routing.js'
import type { BossService } from '../lib/boss.js'
import { env } from '../config/env.js'

export type NotificationTemplate = {
  templateId: string
  payload: Record<string, unknown>
  severity?: NotificationSeverity
}

export type NotificationQueueJob = {
  id: string
  orgId: string
  deliverAt: Date | null
}

const NOTIFICATION_JOB_OPTIONS = {
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 60,
} as const

const SEVERITY_LEVEL: Record<NotificationSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
}

type CreateEntriesOptions = {
  orgId: string
  template: NotificationTemplate
  tx: Tx
}

function nextDigestDeliveryTime(digestHourUtc: number): Date {
  const now = new Date()
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), digestHourUtc)
  )
  if (candidate.getTime() > now.getTime()) return candidate
  return new Date(candidate.getTime() + 24 * 60 * 60 * 1000)
}

function passesSeverityFilter(
  alertSeverity: NotificationSeverity,
  pref: PreferenceOutput
): boolean {
  return SEVERITY_LEVEL[alertSeverity] >= SEVERITY_LEVEL[pref.minSeverity]
}

async function enqueueUserChannel(options: {
  orgId: string
  userId: string
  template: NotificationTemplate
  pref: PreferenceOutput
  tx: Tx
}): Promise<NotificationQueueJob | null> {
  const { orgId, userId, template, pref, tx } = options
  const deliverAt =
    pref.frequency === 'digest_daily' && pref.channel === 'email'
      ? nextDigestDeliveryTime(env.NOTIFICATION_DIGEST_HOUR)
      : null

  const [entry] = await tx
    .insert(notificationQueue)
    .values({
      orgId,
      recipientUserId: userId,
      channel: pref.channel,
      templateId: template.templateId,
      payload: template.payload,
      status: 'pending',
      deliverAt,
    })
    .returning({ id: notificationQueue.id })

  return entry?.id ? { id: entry.id, orgId, deliverAt } : null
}

async function processRecipientPreferences(
  orgId: string,
  userId: string,
  template: NotificationTemplate,
  alertSeverity: NotificationSeverity,
  tx: Tx,
  seenUserChannels: Set<string>
): Promise<{ jobs: NotificationQueueJob[]; slackEnabled: boolean }> {
  const prefs = await getPreferences(orgId, userId, tx)
  const alertPrefs = prefs.filter((p) => p.alertType === template.templateId)
  const jobs: NotificationQueueJob[] = []
  let slackEnabled = false

  for (const pref of alertPrefs) {
    if (!passesSeverityFilter(alertSeverity, pref)) continue

    const dedupKey = `${userId}:${pref.channel}`
    if (seenUserChannels.has(dedupKey)) continue
    seenUserChannels.add(dedupKey)

    if (pref.channel === 'slack') {
      slackEnabled = true
      continue
    }

    const job = await enqueueUserChannel({ orgId, userId, template, pref, tx })
    if (job) jobs.push(job)
  }

  return { jobs, slackEnabled }
}

async function enqueueSlackEntry(
  orgId: string,
  template: NotificationTemplate,
  tx: Tx
): Promise<NotificationQueueJob | null> {
  const [slackEntry] = await tx
    .insert(notificationQueue)
    .values({
      orgId,
      recipientUserId: null,
      channel: 'slack',
      templateId: template.templateId,
      payload: template.payload,
      status: 'pending',
      deliverAt: null,
    })
    .returning({ id: notificationQueue.id })

  return slackEntry?.id ? { id: slackEntry.id, orgId, deliverAt: null } : null
}

export async function createOrgAdminNotificationEntries(
  options: CreateEntriesOptions
): Promise<NotificationQueueJob[]> {
  const { orgId, template, tx } = options
  const alertSeverity = template.severity ?? 'warning'
  const recipientUserIds = await resolveRoutingRecipients(orgId, template.templateId, tx)
  const queueJobs: NotificationQueueJob[] = []
  const seenUserChannels = new Set<string>()
  let slackEnabled = false

  for (const userId of recipientUserIds) {
    const result = await processRecipientPreferences(
      orgId,
      userId,
      template,
      alertSeverity,
      tx,
      seenUserChannels
    )
    queueJobs.push(...result.jobs)
    if (result.slackEnabled) slackEnabled = true
  }

  if (slackEnabled) {
    const slackJob = await enqueueSlackEntry(orgId, template, tx)
    if (slackJob) queueJobs.push(slackJob)
  }

  return queueJobs
}

/** @deprecated Use NotificationQueueJob — kept for transitional callers */
export type NotificationQueueIds = {
  emailIds: Array<{ id: string; orgId: string }>
  slackId?: { id: string; orgId: string }
}

export async function sendNotificationJobs(
  boss: BossService,
  jobs: NotificationQueueJob[]
): Promise<void> {
  if (!boss.isStarted()) {
    process.stderr.write(
      `${JSON.stringify({ eventType: 'notification.dispatch.boss_not_started', jobCount: jobs.length })}\n`
    )
    return
  }

  const now = Date.now()
  for (const job of jobs) {
    if (job.deliverAt !== null && job.deliverAt.getTime() > now) continue
    await boss.send(
      'notification:deliver',
      { notificationQueueId: job.id, orgId: job.orgId },
      NOTIFICATION_JOB_OPTIONS
    )
  }
}

type DispatchOptions = CreateEntriesOptions & {
  boss: BossService
}

export async function dispatchOrgAdminNotification(options: DispatchOptions): Promise<void> {
  const jobs = await createOrgAdminNotificationEntries(options)
  await sendNotificationJobs(options.boss, jobs)
}

export async function enqueueSecurityAlertNotification(opts: {
  orgId: string
  templateId: string
  payload: Record<string, unknown>
  severity?: NotificationSeverity
  tx: Tx
}): Promise<NotificationQueueJob[]> {
  return createOrgAdminNotificationEntries({
    orgId: opts.orgId,
    template: {
      templateId: opts.templateId,
      payload: opts.payload,
      severity: opts.severity,
    },
    tx: opts.tx,
  })
}
