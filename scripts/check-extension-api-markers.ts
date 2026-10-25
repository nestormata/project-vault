#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import semver from 'semver'
import { latestChangelogEntry } from './lib/extension-api-changelog.js'

type DeprecationInput = { indexSource: string; changelogSource: string; currentVersion: string }

function countCharacter(value: string, character: string): number {
  return value.split(character).length - 1
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- bounded scanner preserves JSDoc/export association without backtracking regexes
function exportedBlocks(source: string): Array<{ doc: string; statement: string }> {
  const blocks: Array<{ doc: string; statement: string }> = []
  const lines = source.split('\n')
  let doc = ''
  let statement = ''
  let braceDepth = 0
  let inDoc = false

  const finishStatement = () => {
    if (statement) blocks.push({ doc, statement: statement.trim() })
    doc = ''
    statement = ''
    braceDepth = 0
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (inDoc) {
      doc += `${line}\n`
      if (trimmed.endsWith('*/')) inDoc = false
      continue
    }
    if (trimmed.startsWith('/**')) {
      doc = `${line}\n`
      inDoc = !trimmed.endsWith('*/')
      continue
    }
    if (!statement && trimmed.startsWith('export ')) {
      statement = trimmed
      braceDepth = countCharacter(trimmed, '{') - countCharacter(trimmed, '}')
      if (braceDepth === 0) finishStatement()
      continue
    }
    if (statement) {
      statement += ` ${trimmed}`
      braceDepth += countCharacter(trimmed, '{') - countCharacter(trimmed, '}')
      if (braceDepth <= 0) finishStatement()
    }
  }
  if (statement) finishStatement()
  return blocks
}

function exportedNames(statement: string): string[] {
  const open = statement.indexOf('{')
  const close = statement.lastIndexOf('}')
  if (open !== -1 && close > open)
    return statement
      .slice(open + 1, close)
      .split(',')
      .map((name) => {
        const trimmed = name.trim()
        const alias = trimmed.indexOf(' as ')
        return alias === -1 ? trimmed : trimmed.slice(alias + 4).trim()
      })
      .filter(Boolean)
  const tokens = statement.split(/\s+/)
  const declarationIndex = tokens.findIndex((token) =>
    ['const', 'function', 'class', 'interface', 'type'].includes(token)
  )
  const name = declarationIndex === -1 ? undefined : tokens[declarationIndex + 1]
  const identifier = name ? /^[A-Za-z0-9_$]*/.exec(name)?.[0] : undefined
  return identifier ? [identifier] : []
}

export function checkExperimentalMarkers(source: string): string[] {
  const errors: string[] = []
  for (const block of exportedBlocks(source)) {
    for (const name of exportedNames(block.statement)) {
      const experimental = /@experimental\b/.test(block.doc)
      if (name.startsWith('Unstable_') !== experimental) {
        errors.push(
          name.startsWith('Unstable_')
            ? `${name}: Unstable_ export is missing @experimental`
            : `${name}: @experimental export must use the Unstable_ prefix`
        )
      }
    }
  }
  return errors
}

function publicationDate(changelog: string, version: string): Date | undefined {
  const escapedVersion = version.replaceAll('.', String.raw`\.`)
  const match = new RegExp(
    String.raw`^##\s+${escapedVersion}(?:\s+|$).*?(\d{4}-\d{2}-\d{2})`,
    'm'
  ).exec(changelog)
  if (!match) return undefined
  return parseIsoDate(match[1])
}

const ENTRY_HEADING = /^##\s+(\d+\.\d+\.\d+)\b.*?(\d{4}-\d{2}-\d{2})/
const DEPRECATED_SECTION = /^### Deprecated[\s\S]*?(?=^### |^## |(?![\s\S]))/m

function namesSymbol(text: string, symbol: string): boolean {
  return text.split(/[^\w$]+/).includes(symbol)
}

/**
 * The policy's clock starts when the deprecation is published, not at each later release: the
 * oldest CHANGELOG entry whose `### Deprecated` section names the symbol (whole word). A symbol no
 * entry names yet is being deprecated now, so the current version's entry is its publication.
 */
function deprecationPublicationDate(
  changelog: string,
  symbol: string,
  currentVersion: string
): Date | undefined {
  const entries = changelog.split(/^(?=## )/m)
  const deprecating = entries
    .filter((entry) => ENTRY_HEADING.test(entry))
    .filter((entry) => namesSymbol(DEPRECATED_SECTION.exec(entry)?.[0] ?? '', symbol))
    .map((entry) => ENTRY_HEADING.exec(entry)?.[2])
    .filter((date): date is string => date !== undefined)
    .map(parseIsoDate)
    .filter((date): date is Date => date !== undefined)
    .sort((left, right) => left.valueOf() - right.valueOf())
  return deprecating[0] ?? publicationDate(changelog, currentVersion)
}

function parseIsoDate(value: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!parts) return undefined
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : undefined
}

function validateNotice(
  symbol: string,
  noticeText: string | undefined,
  published: Date | undefined
): string[] {
  const notice = noticeText ? parseIsoDate(noticeText) : undefined
  if (!notice) return [`${symbol}: missing or invalid notice-window-ends field`]
  if (!published) return [`${symbol}: no dated CHANGELOG entry publishes this deprecation`]
  return notice.valueOf() < published.valueOf() + 90 * 24 * 60 * 60 * 1000
    ? [`${symbol}: notice-window-ends must be at least 90 days after publication`]
    : []
}

function validateDeprecationEntry(
  block: string,
  symbol: string,
  current: semver.SemVer | null,
  published: Date | undefined
): string[] {
  const errors: string[] = []
  const replacement = /replacement:\s*(\S.*)/.exec(block)?.[1]
  const removalText = /earliest-removal:\s*(\S+)/.exec(block)?.[1]
  const noticeText = /notice-window-ends:\s*(\S+)/.exec(block)?.[1]
  if (!replacement) errors.push(`${symbol}: missing replacement field`)
  const removal = removalText ? semver.parse(removalText) : null
  if (!removalText || !removal) errors.push(`${symbol}: missing or invalid earliest-removal field`)
  else if (current && removal.major <= current.major)
    errors.push(`${symbol}: earliest-removal must use a higher major`)
  errors.push(...validateNotice(symbol, noticeText, published))
  return errors
}

export function checkDeprecationMarkers(input: DeprecationInput): string[] {
  const errors: string[] = []
  const current = semver.parse(input.currentVersion)
  const deprecatedSymbols: string[] = []
  for (const match of input.indexSource.matchAll(
    /\/\*\*[\s\S]*?@deprecated[\s\S]*?\*\/\s*(export\s+[^\n]+)/g
  )) {
    const symbol = exportedNames(match[1])[0] ?? 'unknown symbol'
    deprecatedSymbols.push(symbol)
    const published = deprecationPublicationDate(
      input.changelogSource,
      symbol,
      input.currentVersion
    )
    errors.push(...validateDeprecationEntry(match[0], symbol, current, published))
  }
  if (deprecatedSymbols.length > 0) {
    const latest = latestChangelogEntry(input.changelogSource)
    const deprecatedEntry = latest ? DEPRECATED_SECTION.exec(latest)?.[0] : undefined
    for (const symbol of deprecatedSymbols)
      if (!namesSymbol(deprecatedEntry ?? '', symbol))
        errors.push(`${symbol}: CHANGELOG's newest entry must announce this deprecated export`)
  }
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd()
  const indexSource = readFileSync(resolve(root, 'packages/extension-api/src/index.ts'), 'utf8')
  const changelogSource = readFileSync(resolve(root, 'packages/extension-api/CHANGELOG.md'), 'utf8')
  const packageJson = JSON.parse(
    readFileSync(resolve(root, 'packages/extension-api/package.json'), 'utf8')
  ) as { version: string }
  const errors = [
    ...checkExperimentalMarkers(indexSource),
    ...checkDeprecationMarkers({
      indexSource,
      changelogSource,
      currentVersion: packageJson.version,
    }),
  ]
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`)
    process.exitCode = 1
  } else
    process.stdout.write('check-extension-api-markers: experimental and deprecation markers — OK\n')
}
