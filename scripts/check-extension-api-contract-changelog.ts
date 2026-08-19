#!/usr/bin/env tsx
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Overrides = { snapshotText?: string; behaviourText?: string; changelogText?: string }
type Result = { ok: true } | { ok: false; errors: string[] }

function contractInputs(root: string, overrides: Overrides): string {
  const surface =
    overrides.snapshotText ??
    readFileSync(resolve(root, 'packages/extension-api/api-surface.snapshot.md'), 'utf8')
  const behaviour =
    overrides.behaviourText ??
    readFileSync(resolve(root, 'packages/extension-api/contract-behaviour.snapshot.md'), 'utf8')
  return `api-surface.snapshot.md\n${surface}\ncontract-behaviour.snapshot.md\n${behaviour}`
}

export function calculateContractHash(root: string, overrides: Overrides = {}): string {
  return createHash('sha256').update(contractInputs(root, overrides)).digest('hex')
}

function deprecatedChangelogErrors(changelog: string): string[] {
  const errors: string[] = []
  for (const match of changelog.matchAll(/### Deprecated[\s\S]*?(?=^### |^## |$)/gm)) {
    const entry = match[0]
    if (!/^\s*(?:[-*]\s*)?Notified:\s*\d{4}-\d{2}-\d{2},\s*[^\n]+$/m.test(entry))
      errors.push(
        'deprecated changelog entry is missing a conforming Notified: date, channel, and recipient line'
      )
    for (const field of ['earliest-removal:', 'notice-window-ends:'])
      if (!entry.includes(field)) errors.push(`deprecated changelog entry is missing ${field}`)
  }
  return errors
}

export function checkContractChangelog(root: string, overrides: Overrides = {}): Result {
  const changelog =
    overrides.changelogText ??
    readFileSync(resolve(root, 'packages/extension-api/CHANGELOG.md'), 'utf8')
  const errors = deprecatedChangelogErrors(changelog)
  const actual = calculateContractHash(root, overrides)
  const recorded = changelog.match(/^contract-hash:\s*sha256:([a-f0-9]{64})\s*$/m)?.[1]
  if (!recorded) errors.push('CHANGELOG is missing a contract-hash: sha256:<64 hex> line')
  else if (recorded !== actual)
    errors.push(`contract-hash mismatch: expected ${actual}, found ${recorded}`)
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkContractChangelog(process.cwd())
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n`)
    process.exitCode = 1
  } else
    process.stdout.write(
      'check-extension-api-contract-changelog: snapshot hash and deprecation records — OK\n'
    )
}
