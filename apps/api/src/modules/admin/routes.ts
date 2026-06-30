import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute } from '../../lib/secure-route.js'
import { env } from '../../config/env.js'
import { getEmailTransport } from '../../workers/notification-email.js'
import { renderEmailTemplate, renderSlackTemplate } from '../../notifications/templates/index.js'
import { NotificationTestResponseSchema } from './schema.js'

const TEST_TEMPLATE_ID = 'security.failed_auth_threshold'
const TEST_PAYLOAD = {
  thresholdType: 'ip' as const,
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: new Date(Date.now() - 300_000).toISOString(),
  windowEnd: new Date().toISOString(),
  ipAddress: '203.0.113.1',
}

export async function adminRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/notifications/test',
    schema: {
      response: {
        200: NotificationTestResponseSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: true,
      rateLimit: { max: 10, key: 'POST /admin/notifications/test' },
      writeAuditEvent: false,
    },
    handler: async (_ctx, _req: FastifyRequest, _reply: FastifyReply) => {
      const email = await testEmailDelivery()
      const slack = await testSlackDelivery()
      return { email, slack }
    },
  })
}

async function testEmailDelivery(): Promise<'delivered' | 'failed' | 'not_configured'> {
  const transport = getEmailTransport()
  if (!transport) return 'not_configured'
  try {
    const { subject, text, html } = renderEmailTemplate(TEST_TEMPLATE_ID, TEST_PAYLOAD)
    const sendPromise = transport.sendMail({
      from: env.SMTP_FROM,
      to: env.SMTP_FROM,
      subject: `[TEST] ${subject}`,
      text: `[THIS IS A TEST MESSAGE]\n\n${text}`,
      html: `<p><em>[THIS IS A TEST MESSAGE]</em></p>${html}`,
    })
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SMTP test timed out after 5s')), 5000)
    )
    await Promise.race([sendPromise, timeoutPromise])
    return 'delivered'
  } catch {
    return 'failed'
  }
}

async function testSlackDelivery(): Promise<'delivered' | 'failed' | 'not_configured'> {
  const webhookUrl = env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return 'not_configured'
  try {
    const { text, blocks } = renderSlackTemplate(TEST_TEMPLATE_ID, TEST_PAYLOAD)
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `[TEST] ${text}`, blocks }),
    })
    return response.ok ? 'delivered' : 'failed'
  } catch {
    return 'failed'
  }
}
