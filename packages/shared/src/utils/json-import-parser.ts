import type { ParsedEnvEntry, ParseWarning } from './env-parser.js'

export type JsonParseResult = {
  entries: ParsedEnvEntry[]
  warnings: ParseWarning[]
}

export class ImportValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ImportValidationError'
  }
}

function parseJsonRoot(content: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ImportValidationError('File is not valid JSON', 'invalid_json')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ImportValidationError(
      'JSON import must be a flat top-level object (e.g. { "KEY": "value" })',
      'invalid_json_structure'
    )
  }

  return parsed as Record<string, unknown>
}

function parseJsonEntry(
  key: string,
  val: unknown
): { entry: ParsedEnvEntry; warning?: ParseWarning } {
  if (typeof val === 'object' && val !== null) {
    throw new ImportValidationError(
      `Key "${key}" has a nested object/array value — only flat string values are supported`,
      'nested_value'
    )
  }

  if (val === null) {
    return {
      entry: { name: key, value: '' },
      warning: { line: 0, reason: 'empty_value', raw: key },
    }
  }

  // val is now known to be a JSON primitive (string | number | boolean) — object/array and
  // null were excluded above, so this stringification can never hit the default
  // "[object Object]" toString.
  const primitive: string | number | boolean = val as string | number | boolean
  const value = String(primitive)
  return {
    entry: { name: key, value },
    warning: value === '' ? { line: 0, reason: 'empty_value', raw: key } : undefined,
  }
}

export function parseJsonImportFile(content: string): JsonParseResult {
  const obj = parseJsonRoot(content)
  const entries: ParsedEnvEntry[] = []
  const warnings: ParseWarning[] = []

  for (const [key, val] of Object.entries(obj)) {
    if (key === '') continue
    const parsed = parseJsonEntry(key, val)
    if (parsed.warning) warnings.push(parsed.warning)
    entries.push(parsed.entry)
  }

  return { entries, warnings }
}
