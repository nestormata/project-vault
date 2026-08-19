#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import semver from 'semver'

type DeprecationInput = { indexSource: string; changelogSource: string; currentVersion: string }

function exportedBlocks(source: string): Array<{ doc: string; statement: string }> {
  return [
    ...source.matchAll(
      /(\/\*\*[\s\S]*?\*\/\s*)?(export\s+(?:type\s+)?(?:\{[^}]*\}|(?:const|function|class|interface|type)\s+[A-Za-z_$][\w$]*))/g
    ),
  ].map((match) => ({ doc: match[1] ?? '', statement: match[2] }))
}

function exportedNames(statement: string): string[] {
  const braces = statement.match(/\{([^}]*)\}/)?.[1]
  if (braces)
    return braces
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0])
      .filter(Boolean)
  const name = statement.match(/(?:const|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/)?.[1]
  return name ? [name] : []
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
  const match = changelog.match(
    new RegExp(`^##\\s+${version.replaceAll('.', '\\.')}(?:\\s+|$).*?(\\d{4}-\\d{2}-\\d{2})`, 'm')
  )
  if (!match) return undefined
  const date = new Date(`${match[1]}T00:00:00.000Z`)
  return Number.isNaN(date.valueOf()) ? undefined : date
}

function validateNotice(
  symbol: string,
  noticeText: string | undefined,
  published: Date | undefined
): string[] {
  if (!noticeText || !/^\d{4}-\d{2}-\d{2}$/.test(noticeText))
    return [`${symbol}: missing or invalid notice-window-ends field`]
  const notice = new Date(`${noticeText}T00:00:00.000Z`)
  if (Number.isNaN(notice.valueOf()))
    return [`${symbol}: missing or invalid notice-window-ends field`]
  return published && notice.valueOf() < published.valueOf() + 90 * 24 * 60 * 60 * 1000
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
  const replacement = block.match(/replacement:\s*(\S.*)/)?.[1]
  const removalText = block.match(/earliest-removal:\s*(\S+)/)?.[1]
  const noticeText = block.match(/notice-window-ends:\s*(\S+)/)?.[1]
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
  const published = publicationDate(input.changelogSource, input.currentVersion)
  for (const match of input.indexSource.matchAll(
    /\/\*\*[\s\S]*?@deprecated[\s\S]*?\*\/\s*(export\s+[^\n]+)/g
  )) {
    const symbol = exportedNames(match[1])[0] ?? 'unknown symbol'
    errors.push(...validateDeprecationEntry(match[0], symbol, current, published))
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
