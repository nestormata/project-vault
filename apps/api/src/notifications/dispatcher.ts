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
  // Story 8.3 D12/AC-16 — lets a caller (user-dormancy-check.ts) supply a pre-resolved recipient
  // list (the owner+admin union, or an org's explicit override) instead of the default single-
  // role resolveRoutingRecipients() lookup below. Every other caller omits this and gets the
  // unchanged default behavior.
  recipientUserIds?: string[]
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
  const recipientUserIds =
    options.recipientUserIds ?? (await resolveRoutingRecipients(orgId, template.templateId, tx))
  const queueJobs: NotificationQueueJob[] = []
  const seenUserChannels = new Set<string>()
  let slackEnabled = false

  // TODO(perf): one getPreferences() query per recipient — batch this into a single
  // query keyed by userId once routing tables grow past small org member counts
  // (deferred-work.md — Epic 3 closure, Story 3.4 AC-16).
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
      'notification/deliver',
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

/**
 * Delivers a notification to a specific user (self-alert) — e.g. MFA recovery events.
 * Skips org routing and uses that user's own preferences only. Enqueues email and
 * inbox channels only; never slack (ADR-3.4-07 — org Slack webhook is the wrong
 * audience for an account-recovery self-alert).
 */
export async function dispatchDirectUserNotification(opts: {
  orgId: string
  userId: string
  template: NotificationTemplate
  tx: Tx
}): Promise<NotificationQueueJob[]> {
  const { orgId, userId, template, tx } = opts
  const alertSeverity = template.severity ?? 'warning'
  const prefs = await getPreferences(orgId, userId, tx)
  const alertPrefs = prefs.filter(
    (p) => p.alertType === template.templateId && p.channel !== 'slack'
  )

  const jobs: NotificationQueueJob[] = []
  const seenChannels = new Set<string>()
  for (const pref of alertPrefs) {
    if (!passesSeverityFilter(alertSeverity, pref)) continue
    if (seenChannels.has(pref.channel)) continue
    seenChannels.add(pref.channel)

    const job = await enqueueUserChannel({ orgId, userId, template, pref, tx })
    if (job) jobs.push(job)
  }

  return jobs
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
