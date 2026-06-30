import {
  renderSecurityFailedAuthThreshold,
  renderSecurityFailedAuthThresholdSlack,
} from './security-failed-auth-threshold.js'

export type EmailRender = { subject: string; text: string; html: string }
export type SlackRender = { text: string; blocks: unknown[] }

const EMAIL_RENDERERS: Record<string, (payload: Record<string, unknown>) => EmailRender> = {
  'security.failed_auth_threshold': renderSecurityFailedAuthThreshold,
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
    return {
      subject: `[Project Vault] Notification (${templateId})`,
      text: `A vault notification was triggered. Template: ${templateId}.\nPayload: ${JSON.stringify(payload, null, 2)}`,
      html: `<p>A vault notification was triggered.</p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
    }
  }
  return renderer(payload)
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
