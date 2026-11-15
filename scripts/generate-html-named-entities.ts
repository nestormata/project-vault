#!/usr/bin/env tsx
/**
 * Regenerates scripts/lib/html5-named-entities.json and
 * scripts/lib/html5-named-entities-optional.json from a local WHATWG entities.json.
 *
 *   tsx scripts/generate-html-named-entities.ts --from /path/to/entities.json
 *
 * Source: https://html.spec.whatwg.org/entities.json
 */
import { resolve } from 'node:path'
import { option, runAsMain } from './lib/cli-io.js'
import { readText, writeText } from './lib/fs-access.js'

const DEFAULT_OUT = 'scripts/lib/html5-named-entities.json'

export type WhatwgNamedTables = {
  semicolonTerminated: Record<string, string>
  optionalSemicolon: Record<string, string>
}

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

function sortedRecord(names: Map<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...names.entries()].sort(([left], [right]) => left.localeCompare(right))
  )
}

function optionalOutPath(out: string): string {
  return out.endsWith('.json') ? `${out.slice(0, -5)}-optional.json` : `${out}-optional.json`
}

export function namedCharacterTablesFromWhatwg(source: unknown): WhatwgNamedTables {
  if (!isRecord(source)) {
    throw new Error('WHATWG entities.json must be an object')
  }
  const semicolonTerminated = new Map<string, string>()
  const optionalSemicolon = new Map<string, string>()
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('&')) continue
    const characters = namedCharacters(key, value)
    if (key.endsWith(';')) {
      semicolonTerminated.set(key.slice(1, -1), characters)
    } else {
      optionalSemicolon.set(key.slice(1), characters)
    }
  }
  return {
    semicolonTerminated: sortedRecord(semicolonTerminated),
    optionalSemicolon: sortedRecord(optionalSemicolon),
  }
}

export function run(args: readonly string[]): number {
  const from = option(args, '--from')
  if (from === undefined) {
    process.stderr.write(
      'usage: generate-html-named-entities --from <entities.json> [--out <path>] [--optional-out <path>]\n'
    )
    return 1
  }
  const out = option(args, '--out') ?? DEFAULT_OUT
  const optionalOut = option(args, '--optional-out') ?? optionalOutPath(out)
  const tables = namedCharacterTablesFromWhatwg(JSON.parse(readText(resolve(from))) as unknown)
  writeText(resolve(out), `${JSON.stringify(tables.semicolonTerminated)}\n`)
  writeText(resolve(optionalOut), `${JSON.stringify(tables.optionalSemicolon)}\n`)
  process.stdout.write(
    `wrote ${Object.keys(tables.semicolonTerminated).length} semicolon-terminated names to ${out} and ${Object.keys(tables.optionalSemicolon).length} optional-semicolon names to ${optionalOut}\n`
  )
  return 0
}

runAsMain(import.meta.url, run)
