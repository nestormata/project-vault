import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { operationalLog, serializeLogError } from '../../lib/logger.js'
import {
  renderSecurityFailedAuthThreshold,
  renderSecurityFailedAuthThresholdSlack,
} from './security-failed-auth-threshold.js'
import {
  renderSecurityMfaRecoveryCodesRegenerated,
  renderSecurityMfaRecoveryUsed,
} from './security-mfa-recovery.js'
import { renderProjectInvitationCreated } from './project-invitation-created.js'
import { renderCredentialShareCreated } from './credential-share-created.js'
import {
  renderAccountRecoveryLinkCreated,
  renderAccountRecoveryLinkSent,
} from './account-recovery.js'

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
  'security.mfa_recovery_used': (payload) => {
    const { subject, text, html } = renderSecurityMfaRecoveryUsed(payload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
  'security.mfa_recovery_codes_regenerated': (payload) => {
    const { subject, text, html } = renderSecurityMfaRecoveryCodesRegenerated(payload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
  'project.invitation_created': (payload) => {
    const { subject, text, html } = renderProjectInvitationCreated(payload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
  'auth.recovery_link_created': (payload) => {
    const { subject, text, html } = renderAccountRecoveryLinkCreated(payload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
  'auth.recovery_link_sent': (payload) => {
    const { subject, text, html } = renderAccountRecoveryLinkSent(payload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
  'credential.share_created': (payload) => {
    const { subject, text, html } = renderCredentialShareCreated(payload)
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

type NotificationLogger = Pick<FastifyBaseLogger, 'error'>

function genericEmailFallback(templateId: string, payload: Record<string, unknown>): EmailRender {
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

function genericSlackFallback(templateId: string): SlackRender {
  return {
    text: `[Project Vault] Notification: ${templateId}`,
    blocks: [],
  }
}

// Story 28.6 AC3 — defense-in-depth beyond AC1/AC2's direct field-level fixes: ANY registered
// renderer that throws (a future bug in this file or another) degrades to the same generic
// passthrough shape already used for an unregistered templateId, instead of propagating and
// crash-looping the whole notification/deliver pipeline. Logs error-level with both templateId
// and the raw payload that triggered the failure (closes the traceability gap named in this
// story's Root Cause — today's withJobLogging error log carries the exception but never the
// payload). `logger` is optional so this stays a pure function for callers/tests with none;
// callers that have a logger (the actual delivery workers) should always pass one.
export function renderEmailTemplate(
  templateId: string,
  payload: Record<string, unknown>,
  logger?: NotificationLogger
): EmailRender {
  const renderer = EMAIL_RENDERERS[templateId]
  if (!renderer) {
    return genericEmailFallback(templateId, payload)
  }
  try {
    return renderer(payload)
  } catch (err) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.NOTIFICATION_TEMPLATE_RENDER_FAILED,
        'Notification template render failed; falling back to generic passthrough',
        { templateId, payload, err: serializeLogError(err) }
      )
    }
    return genericEmailFallback(templateId, payload)
  }
}

export function renderTemplate(
  templateId: string,
  payload: Record<string, unknown>,
  logger?: NotificationLogger
): EmailRender {
  return renderEmailTemplate(templateId, payload, logger)
}

export function renderSlackTemplate(
  templateId: string,
  payload: Record<string, unknown>,
  logger?: NotificationLogger
): SlackRender {
  const renderer = SLACK_RENDERERS[templateId]
  if (!renderer) {
    return genericSlackFallback(templateId)
  }
  try {
    return renderer(payload)
  } catch (err) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.NOTIFICATION_TEMPLATE_RENDER_FAILED,
        'Notification template render failed; falling back to generic passthrough',
        { templateId, payload, err: serializeLogError(err) }
      )
    }
    return genericSlackFallback(templateId)
  }
}
