export function highlightParts(
  text: string,
  query: string
): Array<{ text: string; match: boolean }> {
  if (!query.trim()) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const idx = lower.indexOf(needle)
  if (idx === -1) return [{ text, match: false }]
  return [
    { text: text.slice(0, idx), match: false },
    { text: text.slice(idx, idx + query.length), match: true },
    { text: text.slice(idx + query.length), match: false },
  ].filter((part) => part.text.length > 0)
}

export function expiresWithinDays(expiresAt: string | null, days = 30): boolean {
  if (!expiresAt) return false
  const expires = new Date(expiresAt).getTime()
  const now = Date.now()
  const windowMs = days * 24 * 60 * 60 * 1000
  return expires > now && expires - now <= windowMs
}

export function daysUntil(expiresAt: string): number {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
}
