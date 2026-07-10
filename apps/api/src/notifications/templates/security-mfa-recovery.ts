export type MfaRecoveryPayload = {
  userId: string
  remainingRecoveryCodes: number
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderSecurityMfaRecoveryUsed(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as MfaRecoveryPayload
  const subject = `[Project Vault] MFA recovery code used on your account`

  const text = [
    'Security Alert — Project Vault',
    '',
    'A multi-factor authentication recovery code was used to sign in to your account.',
    '',
    `  Remaining recovery codes: ${p.remainingRecoveryCodes}`,
    '',
    'If this was not you, revoke your sessions and regenerate your recovery codes immediately.',
    '',
    'This is an automated message from Project Vault.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>MFA Recovery Code Used</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#dc2626;">⚠️ MFA Recovery Code Used</h2>
  <p>A multi-factor authentication recovery code was used to sign in to your account.</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Remaining recovery codes</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(String(p.remainingRecoveryCodes))}</td></tr>
  </table>
  <p>If this was not you, revoke your sessions and regenerate your recovery codes immediately.</p>
  <hr><p style="color:#6b7280;font-size:12px;">This is an automated message from Project Vault.</p>
</body>
</html>`

  return { subject, text, html }
}

export function renderSecurityMfaRecoveryCodesRegenerated(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as MfaRecoveryPayload
  const subject = `[Project Vault] MFA recovery codes were regenerated`

  const text = [
    'Security Notice — Project Vault',
    '',
    'Your multi-factor authentication recovery codes were regenerated.',
    '',
    `  New unused recovery codes: ${p.remainingRecoveryCodes}`,
    '',
    'Previously issued recovery codes are no longer valid.',
    'If this was not you, revoke your sessions immediately.',
    '',
    'This is an automated message from Project Vault.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>MFA Recovery Codes Regenerated</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#b45309;">🔐 MFA Recovery Codes Regenerated</h2>
  <p>Your multi-factor authentication recovery codes were regenerated.</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">New unused recovery codes</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(String(p.remainingRecoveryCodes))}</td></tr>
  </table>
  <p>Previously issued recovery codes are no longer valid. If this was not you, revoke your sessions immediately.</p>
  <hr><p style="color:#6b7280;font-size:12px;">This is an automated message from Project Vault.</p>
</body>
</html>`

  return { subject, text, html }
}
