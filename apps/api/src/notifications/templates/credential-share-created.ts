export type CredentialShareCreatedPayload = {
  shareId: string
  credentialId: string
  sharedByUserId: string
  fieldKey: string | null
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// Story 17.1 AC-10: "A credential was shared with you" — direct-to-recipient notification (not
// FR100's org-wide alert routing). Deliberately does NOT embed the raw share link/token in this
// notification body — the sharer's one-time link display (AC-18) is the only place the token is
// ever shown; the recipient follows up from their in-app Shares inbox, keeping the token out of
// email/Slack transport entirely.
export function renderCredentialShareCreated(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as CredentialShareCreatedPayload
  const subject = '[Project Vault] A credential was shared with you'
  const fieldNote = p.fieldKey ? ` (field: ${p.fieldKey})` : ''

  const text = [
    `A teammate shared a credential with you${fieldNote}.`,
    '',
    'Open Project Vault and check your Shares to view it.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>A credential was shared with you</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>A credential was shared with you</h2>
  <p>A teammate shared a credential with you${escapeHtml(fieldNote)}.</p>
  <p>Open Project Vault and check your Shares to view it.</p>
</body>
</html>`

  return { subject, text, html }
}
