// Story 43-17 / DW-544 item 2: notice to the new owner when a deactivated/removed user's rotations
// are transferred to them. Payload ids (rotation ids, previous owner) are deliberately NOT
// rendered: the notice carries a count only, no credential or secret values, and the new owner
// follows up from the rotations view in the app (no deep link: templates have no base-URL source).
function countOrNull(raw: Record<string, unknown>): number | null {
  const value = raw.rotationCount
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function headline(count: number | null): string {
  if (count === null) return 'Rotations were transferred to you'
  return count === 1
    ? '1 rotation was transferred to you'
    : `${count} rotations were transferred to you`
}

export function renderRotationOwnershipTransferred(raw: Record<string, unknown>): {
  subject: string
  text: string
  html: string
} {
  const title = headline(countOrNull(raw))
  const subject = `[Project Vault] ${title}`
  const explanation = 'The previous owner was deactivated or removed from the organization.'
  const followUp = 'Open Project Vault and review your rotations to continue or finish them.'

  const text = [
    `${title} because the previous owner was deactivated or removed.`,
    '',
    followUp,
    '',
    'This is an automated message from Project Vault.',
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>${title}</h2>
  <p>${explanation}</p>
  <p>${followUp}</p>
  <hr><p style="color:#6b7280;font-size:12px;">This is an automated message from Project Vault.</p>
</body>
</html>`

  return { subject, text, html }
}
