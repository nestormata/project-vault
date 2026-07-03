export type AccountRecoveryPayload = {
  recoveryUrl: string
  initiatorEmail: string | null
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Self-requested recovery link (AC-9, templateId 'auth.recovery_link_created'). Copy is framed
 * as "you asked for this" — distinct from the admin-sent variant below, so a recipient who did
 * *not* request this has an immediate anti-phishing tell (adversarial review MEDIUM finding).
 */
export function renderAccountRecoveryLinkCreated(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as AccountRecoveryPayload
  const subject = `[Project Vault] Reset your password`

  const text = [
    'You requested a password reset for your Project Vault account.',
    '',
    `Reset your password: ${p.recoveryUrl}`,
    '',
    'This link expires in 15 minutes and can only be used once.',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Reset your password</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>Reset your password</h2>
  <p>You requested a password reset for your Project Vault account.</p>
  <p><a href="${escapeHtml(p.recoveryUrl)}" style="display:inline-block;padding:10px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:8px;">Reset password</a></p>
  <p style="color:#6b7280;font-size:12px;">This link expires in 15 minutes and can only be used once. If you didn't request this, you can safely ignore this email.</p>
</body>
</html>`

  return { subject, text, html }
}

/**
 * Admin-sent recovery link (AC-10, templateId 'auth.recovery_link_sent'). Copy names the
 * initiating admin explicitly, since the recipient did not themselves trigger this email.
 */
export function renderAccountRecoveryLinkSent(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as AccountRecoveryPayload
  const initiator = p.initiatorEmail ?? 'An organization admin'
  const subject = `[Project Vault] Your admin sent you a password reset link`

  const text = [
    `${initiator} sent you a link to reset your Project Vault password.`,
    '',
    `Reset your password: ${p.recoveryUrl}`,
    '',
    'This link expires in 15 minutes and can only be used once.',
    "If you weren't expecting this, contact your organization admin before using the link.",
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Password reset requested by your admin</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>Your admin sent you a password reset link</h2>
  <p>${escapeHtml(initiator)} sent you a link to reset your Project Vault password.</p>
  <p><a href="${escapeHtml(p.recoveryUrl)}" style="display:inline-block;padding:10px 20px;background:#0f172a;color:#fff;text-decoration:none;border-radius:8px;">Reset password</a></p>
  <p style="color:#6b7280;font-size:12px;">This link expires in 15 minutes and can only be used once. If you weren't expecting this, contact your organization admin before using the link.</p>
</body>
</html>`

  return { subject, text, html }
}
