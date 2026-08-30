export type FailedAuthThresholdPayload = {
  thresholdType: 'ip' | 'account'
  thresholdCount: number
  windowSeconds: number
  attemptCount: number
  windowStart: string
  windowEnd: string
  ipAddress?: string
  userId?: string
}

// notification_queue.payload is stored as untyped JSON — a malformed or missing string field
// must not silently throw (Story 28.6 AC1). Hardened to accept string | undefined | null (and
// coerce any other non-string shape safely) rather than trusting the caller's type-asserted
// signature, since every render call site blind-casts `raw as <Payload>` with no re-validation.
function escapeHtml(str: string | undefined | null): string {
  const safe = typeof str === 'string' ? str : ''
  return safe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// Story 28.6 AC1 — windowStart/windowEnd are declared as required strings, but an untyped
// notification_queue.payload row can arrive missing them (or with the wrong type) at render
// time; fall back to 'unknown' the same way the existing `who` line already handles
// ipAddress/userId, instead of throwing.
function windowBoundOrFallback(value: unknown): string {
  return typeof value === 'string' ? value : 'unknown'
}

// Guards Math.round(windowSeconds / 60) from producing NaN when windowSeconds is
// missing/malformed, matching the same defensive tone as the fallback above.
function windowMinutesOrFallback(value: unknown): number | string {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / 60) : 'unknown'
}

export function renderSecurityFailedAuthThreshold(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const p = raw as FailedAuthThresholdPayload
  const who =
    p.thresholdType === 'ip'
      ? `IP address ${p.ipAddress ?? 'unknown'}`
      : `user account ${p.userId ?? 'unknown'}`
  const window = windowMinutesOrFallback(p.windowSeconds)
  const windowStart = windowBoundOrFallback(p.windowStart)
  const windowEnd = windowBoundOrFallback(p.windowEnd)

  const subject = `[Project Vault] Security Alert: Failed login threshold exceeded`

  const text = [
    'Security Alert — Project Vault',
    '',
    'Failed authentication threshold exceeded.',
    '',
    `  Source: ${who}`,
    `  Attempts: ${p.attemptCount} in ${window} minutes`,
    `  Window: ${windowStart} — ${windowEnd}`,
    '',
    'Review the security alerts dashboard to investigate and dismiss this alert.',
    '',
    'This is an automated message from Project Vault.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Security Alert</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#dc2626;">⚠️ Security Alert</h2>
  <p>Failed authentication threshold exceeded.</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Source</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(who)}</td></tr>
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Attempts</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${p.attemptCount} in ${window} minutes</td></tr>
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Window</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(windowStart)} — ${escapeHtml(windowEnd)}</td></tr>
  </table>
  <p>Review the <a href="#">security alerts dashboard</a> to investigate and dismiss this alert.</p>
  <hr><p style="color:#6b7280;font-size:12px;">This is an automated message from Project Vault.</p>
</body>
</html>`

  return { subject, text, html }
}

export function renderSecurityFailedAuthThresholdSlack(raw: Record<string, unknown>): {
  text: string
  blocks: unknown[]
} {
  const p = raw as FailedAuthThresholdPayload
  const who =
    p.thresholdType === 'ip'
      ? `IP \`${p.ipAddress ?? 'unknown'}\``
      : `user \`${p.userId ?? 'unknown'}\``
  const window = windowMinutesOrFallback(p.windowSeconds)
  const windowStart = windowBoundOrFallback(p.windowStart)
  const windowEnd = windowBoundOrFallback(p.windowEnd)

  return {
    text: '[Project Vault] Security Alert: Failed login threshold exceeded',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔴 Security Alert — Project Vault', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Failed authentication threshold exceeded*\n${p.attemptCount} attempts from ${who} in the past ${window} minutes.`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Window: ${windowStart} — ${windowEnd}` }],
      },
    ],
  }
}
