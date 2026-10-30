import { escapeHtml } from './html-safety.js'

export type CredentialShareVerificationCodePayload = {
  code: string
  sharedByDisplayName: string
}

/**
 * Story 72-11 V11: the guest recipient's verification code for a native external share. Plain
 * text first (a registered delivery provider takes over all PV email as plain text); the HTML part
 * carries the same sentences. No link and no credential name: the email proves the mailbox, it
 * must never open the share on its own. The queue row's `code` is scrubbed once delivery reaches
 * a final state (`applyDeliveryStatusUpdate`), so a scrubbed row still renders without throwing.
 */
export function renderCredentialShareVerificationCode(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const code = typeof raw['code'] === 'string' ? raw['code'] : ''
  const sharer =
    typeof raw['sharedByDisplayName'] === 'string' && raw['sharedByDisplayName'] !== ''
      ? raw['sharedByDisplayName']
      : 'A teammate'
  const subject = '[Project Vault] Your verification code'
  const lines = [
    `Your verification code is: ${code}`,
    'It is valid for 10 minutes.',
    `${sharer} shared a credential with this address in Project Vault. Enter the code on the page you opened from their link.`,
    'If you did not expect this, ignore this email.',
  ]

  const text = lines.join('\n\n')
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Your verification code</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
${lines.map((line) => `  <p>${escapeHtml(line)}</p>`).join('\n')}
</body>
</html>`

  return { subject, text, html }
}
