import { escapeHtml, safeHref } from './html-safety.js'

export type ProjectInvitationCreatedPayload = {
  projectId: string
  projectName: string
  inviterEmail: string | null
  role: 'admin' | 'member' | 'viewer'
  acceptUrl: string
}

// acceptUrl comes from an untyped, unrevalidated notification_queue.payload row — safeHref (see
// html-safety.ts) makes sure a malformed/tampered `javascript:`/`data:` URI can never render as
// a clickable href in this invitation email.

export function renderProjectInvitationCreated(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as ProjectInvitationCreatedPayload
  const inviter = p.inviterEmail ?? 'A teammate'
  const projectName = p.projectName ?? 'a project'
  const role = p.role ?? 'member'
  const acceptUrl = p.acceptUrl ?? ''

  const subject = `[Project Vault] You've been invited to ${projectName}`

  const text = [
    `${inviter} invited you to join ${projectName} on Project Vault as ${role}.`,
    '',
    `Accept the invitation: ${acceptUrl}`,
    '',
    'This invite expires in 72 hours.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>You've been invited</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>You've been invited to ${escapeHtml(projectName)}</h2>
  <p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(projectName)}</strong> on Project Vault as <strong>${escapeHtml(role)}</strong>.</p>
  <p><a href="${escapeHtml(safeHref(acceptUrl))}" style="display:inline-block;padding:10px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:8px;">Accept Invitation</a></p>
  <p style="color:#6b7280;font-size:12px;">This invite expires in 72 hours.</p>
</body>
</html>`

  return { subject, text, html }
}
