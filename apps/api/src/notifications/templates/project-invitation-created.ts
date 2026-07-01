export type ProjectInvitationCreatedPayload = {
  projectId: string
  projectName: string
  inviterEmail: string | null
  role: 'admin' | 'member' | 'viewer'
  acceptUrl: string
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderProjectInvitationCreated(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as ProjectInvitationCreatedPayload
  const inviter = p.inviterEmail ?? 'A teammate'

  const subject = `[Project Vault] You've been invited to ${p.projectName}`

  const text = [
    `${inviter} invited you to join ${p.projectName} on Project Vault as ${p.role}.`,
    '',
    `Accept the invitation: ${p.acceptUrl}`,
    '',
    'This invite expires in 72 hours.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>You've been invited</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>You've been invited to ${escapeHtml(p.projectName)}</h2>
  <p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(p.projectName)}</strong> on Project Vault as <strong>${escapeHtml(p.role)}</strong>.</p>
  <p><a href="${escapeHtml(p.acceptUrl)}" style="display:inline-block;padding:10px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:8px;">Accept Invitation</a></p>
  <p style="color:#6b7280;font-size:12px;">This invite expires in 72 hours.</p>
</body>
</html>`

  return { subject, text, html }
}
