import {
  renderSecurityFailedAuthThreshold,
  renderSecurityFailedAuthThresholdSlack,
} from './security-failed-auth-threshold.js'

export type EmailRender = {
  subject: string
  text: string
  html: string
  inboxTitle: string
  inboxBody: string
}
export type SlackRender = { text: string; blocks: unknown[] }

const EMAIL_RENDERERS: Record<string, (payload: Record<string, unknown>) => EmailRender> = {
  'security.failed_auth_threshold': (payload) => {
    const { subject, text, html } = renderSecurityFailedAuthThreshold(payload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
}

const SLACK_RENDERERS: Record<string, (payload: Record<string, unknown>) => SlackRender> = {
  'security.failed_auth_threshold': renderSecurityFailedAuthThresholdSlack,
}

export function renderEmailTemplate(
  templateId: string,
  payload: Record<string, unknown>
): EmailRender {
  const renderer = EMAIL_RENDERERS[templateId]
  if (!renderer) {
    const subject = `[Project Vault] Notification (${templateId})`
    const text = `A vault notification was triggered. Template: ${templateId}.\nPayload: ${JSON.stringify(payload, null, 2)}`
    return {
      subject,
      text,
      html: `<p>A vault notification was triggered.</p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
      inboxTitle: `Alert: ${templateId}`,
      inboxBody: `A vault event occurred: ${templateId}`,
    }
  }
  return renderer(payload)
}

export function renderTemplate(templateId: string, payload: Record<string, unknown>): EmailRender {
  return renderEmailTemplate(templateId, payload)
}

export function renderSlackTemplate(
  templateId: string,
  payload: Record<string, unknown>
): SlackRender {
  const renderer = SLACK_RENDERERS[templateId]
  if (!renderer) {
    return {
      text: `[Project Vault] Notification: ${templateId}`,
      blocks: [],
    }
  }
  return renderer(payload)
}
