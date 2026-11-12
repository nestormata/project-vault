#!/usr/bin/env tsx
/**
 * Regenerates scripts/lib/html5-named-entities.json from a local WHATWG entities.json.
 *
 *   tsx scripts/generate-html-named-entities.ts --from /path/to/entities.json
 *
 * Source: https://html.spec.whatwg.org/entities.json
 * Only semicolon-terminated names are kept (optional-semicolon is story 72-30).
 */
import { resolve } from 'node:path'
import { option, runAsMain } from './lib/cli-io.js'
import { readText, writeText } from './lib/fs-access.js'

const DEFAULT_OUT = 'scripts/lib/html5-named-entities.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function namedCharacters(key: string, value: unknown): string {
  if (!isRecord(value) || !('characters' in value)) {
    throw new Error(`invalid WHATWG entry ${key}`)
  }
  const characters = value.characters
  if (typeof characters !== 'string' || characters.length === 0) {
    throw new Error(`invalid characters for ${key}`)
  }
  return characters
}

export function namedEntitiesFromWhatwg(source: unknown): Record<string, string> {
  if (!isRecord(source)) {
    throw new Error('WHATWG entities.json must be an object')
  }
  const names = new Map<string, string>()
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('&') || !key.endsWith(';')) continue
    names.set(key.slice(1, -1), namedCharacters(key, value))
  }
  return Object.fromEntries(
    [...names.entries()].sort(([left], [right]) => left.localeCompare(right))
  )
}

export function run(args: readonly string[]): number {
  const from = option(args, '--from')
  if (from === undefined) {
    process.stderr.write(
      'usage: generate-html-named-entities --from <entities.json> [--out <path>]\n'
    )
    return 1
  }
  const out = option(args, '--out') ?? DEFAULT_OUT
  const table = namedEntitiesFromWhatwg(JSON.parse(readText(resolve(from))) as unknown)
  writeText(resolve(out), `${JSON.stringify(table)}\n`)
  process.stdout.write(`wrote ${Object.keys(table).length} semicolon-terminated names to ${out}\n`)
  return 0
}

runAsMain(import.meta.url, run)
