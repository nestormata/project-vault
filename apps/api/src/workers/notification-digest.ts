import { sql, eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue, users } from '@project-vault/db/schema'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import { getEmailTransport } from './notification-email.js'
import { resolveSmtpTransportConfig } from '../modules/platform-admin/service.js'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

type DigestEntry = {
  id: string
  orgId: string
  recipientUserId: string
  templateId: string
  payload: Record<string, unknown>
}

function renderDigestEmail(entries: DigestEntry[]): {
  subject: string
  text: string
  html: string
} {
  const count = entries.length
  const subject = `[Project Vault] Daily digest: ${count} notification${count === 1 ? '' : 's'}`
  const items = entries.map((e) =>
    renderEmailTemplate(e.templateId, e.payload as Record<string, unknown>)
  )

  const text = [
    'Project Vault — Daily Notification Digest',
    `${count} notification${count === 1 ? '' : 's'} since your last digest:`,
    '',
    ...items.map((item, i) => `--- ${i + 1}. ${item.subject} ---\n${item.text}`),
    '',
    'To manage your notification preferences, visit Settings → Notifications.',
  ].join('\n')

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Daily Digest</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>Project Vault — Daily Digest</h2>
  <p>${count} notification${count === 1 ? '' : 's'} since your last digest:</p>
  ${items
    .map(
      (item, i) => `
    <div style="border:1px solid #e5e7eb;border-radius:4px;padding:16px;margin:16px 0;">
      <h3 style="margin:0 0 8px 0;color:#1f2937;">${i + 1}. ${item.subject.replace('[Project Vault] ', '')}</h3>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#374151;">${item.text}</pre>
    </div>`
    )
    .join('')}
  <hr><p style="color:#6b7280;font-size:12px;">Manage preferences in Settings → Notifications</p>
</body></html>`

  return { subject, text, html }
}

export async function runDigestSend(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  const now = new Date()
  const transport = await getEmailTransport()
  if (!transport) {
    logger.warn(
      { eventType: 'notification.digest.skipped', reason: 'smtp_not_configured' },
      'Digest send skipped: SMTP not configured'
    )
    return
  }

  const { getDb } = await import('@project-vault/db')
  const orgsWithDigestWork = await getDb().execute<{ orgId: string }>(sql`
    SELECT DISTINCT org_id::text AS "orgId"
    FROM notification_queue
    WHERE channel = 'email'
      AND status = 'pending'
      AND deliver_at IS NOT NULL
      AND deliver_at <= ${now.toISOString()}::timestamptz
      AND recipient_user_id IS NOT NULL
  `)

  for (const { orgId } of orgsWithDigestWork) {
    const pendingEntries = await withOrg(orgId, (tx) =>
      tx.execute<DigestEntry>(sql`
        SELECT id::text AS id,
               org_id::text AS "orgId",
               recipient_user_id::text AS "recipientUserId",
               template_id AS "templateId",
               payload
        FROM notification_queue
        WHERE org_id = ${orgId}::uuid
          AND channel = 'email'
          AND status = 'pending'
          AND deliver_at IS NOT NULL
          AND deliver_at <= ${now.toISOString()}::timestamptz
          AND recipient_user_id IS NOT NULL
        ORDER BY recipient_user_id, created_at ASC
      `)
    )

    if (pendingEntries.length === 0) continue

    const byRecipient = new Map<string, DigestEntry[]>()
    for (const entry of pendingEntries) {
      const list = byRecipient.get(entry.recipientUserId) ?? []
      list.push(entry)
      byRecipient.set(entry.recipientUserId, list)
    }

    for (const [recipientUserId, entries] of byRecipient) {
      await withOrg(orgId, async (tx) => {
        const [user] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, recipientUserId))
          .limit(1)

        if (!user?.email) {
          for (const entry of entries) {
            await tx
              .update(notificationQueue)
              .set({ status: 'suppressed' })
              .where(eq(notificationQueue.id, entry.id))
          }
          return
        }

        const { subject, text, html } = renderDigestEmail(entries)
        const smtpConfig = await resolveSmtpTransportConfig()

        try {
          await transport.sendMail({
            from: smtpConfig?.from ?? undefined,
            to: user.email,
            subject,
            text,
            html,
          })

          for (const entry of entries) {
            await tx
              .update(notificationQueue)
              .set({ status: 'delivered', deliveredAt: new Date() })
              .where(eq(notificationQueue.id, entry.id))
          }
        } catch (err) {
          logger.error(
            { eventType: 'notification.digest.send_failed', recipientUserId, err },
            'Digest email send failed'
          )
        }
      })
    }
  }
}

export async function notificationDigestHandler(
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await withJobLogging(logger, 'notification/send-digest', 'daily', () => runDigestSend(logger))
}
