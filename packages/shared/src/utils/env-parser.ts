export type ParsedEnvEntry = {
  name: string
  value: string
}

export type ParseWarning = {
  line: number
  reason: 'no_equals_sign' | 'empty_value' | 'invalid_key' | 'duplicate_key'
  raw: string
}

export type EnvParseResult = {
  entries: ParsedEnvEntry[]
  warnings: ParseWarning[]
}

const KEY_PATTERN = /^[A-Za-z_]\w*$/

function decodeEnvValue(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1)
  }
  const commentIdx = rawValue.indexOf(' #')
  return (commentIdx === -1 ? rawValue : rawValue.slice(0, commentIdx)).trim()
}

function parseEnvLine(
  lineNum: number,
  raw: string
): {
  entry?: ParsedEnvEntry
  warning?: ParseWarning
} {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return {}

  const stripped = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
  const eqIdx = stripped.indexOf('=')
  if (eqIdx === -1) {
    return { warning: { line: lineNum, reason: 'no_equals_sign', raw } }
  }

  const name = stripped.slice(0, eqIdx).trim()
  if (!KEY_PATTERN.test(name)) {
    return { warning: { line: lineNum, reason: 'invalid_key', raw } }
  }

  const value = decodeEnvValue(stripped.slice(eqIdx + 1))
  const warning =
    value === '' ? ({ line: lineNum, reason: 'empty_value', raw } as const) : undefined
  return { entry: { name, value }, warning }
}

export function parseEnvFile(content: string): EnvParseResult {
  const entryMap = new Map<string, ParsedEnvEntry>()
  const warnings: ParseWarning[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseEnvLine(i + 1, lines[i] ?? '')
    if (parsed.warning) warnings.push(parsed.warning)
    if (!parsed.entry) continue

    if (entryMap.has(parsed.entry.name)) {
      warnings.push({ line: i + 1, reason: 'duplicate_key', raw: lines[i] ?? '' })
    }
    entryMap.set(parsed.entry.name, parsed.entry)
  }

  return { entries: Array.from(entryMap.values()), warnings }
}
