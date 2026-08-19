#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type BehaviourContract = {
  reverseDnsNamePattern: string
  includePrerelease: boolean
  loaderTimeoutMs: number
  reasonToStatus: string
}

type SourceOverrides = { registerSource?: string; loaderSource?: string }
type Result = { ok: true } | { ok: false; errors: string[] }

export function extractBehaviourContract(sources: {
  registerSource: string
  loaderSource: string
}): BehaviourContract {
  const patternLine = sources.registerSource
    .split('\n')
    .find((line) => line.includes('const REVERSE_DNS_NAME_PATTERN'))
  const pattern = patternLine?.split('=', 2)[1]?.trim()
  const prerelease = /includePrerelease\s*:\s*(true|false)/.exec(sources.registerSource)?.[1]
  const timeout = /const DEFAULT_TIMEOUT_MS\s*=\s*(\d+)/.exec(sources.loaderSource)?.[1]
  const normalizedLoaderSource = sources.loaderSource
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('//'))
    .join(' ')
  const mapping =
    /return error\.reason === 'invalid-name' \|\| error\.reason === 'invalid-manifest-field' \? '([^']+)' : '([^']+)'/.exec(
      normalizedLoaderSource
    )
  if (!pattern || !prerelease || !timeout || !mapping) {
    throw new Error('could not extract one or more contract behaviour definitions')
  }
  return {
    reverseDnsNamePattern: pattern,
    includePrerelease: prerelease === 'true',
    loaderTimeoutMs: Number(timeout),
    reasonToStatus: `incompatible-version -> ${mapping[2]}; invalid-manifest-field -> ${mapping[1]}; invalid-name -> ${mapping[1]}`,
  }
}

function parseGolden(text: string): BehaviourContract {
  const pattern = /^- reverse-dns-name-pattern: `([^`]+)`$/m.exec(text)?.[1]
  const prerelease = /^- include-prerelease: (true|false)$/m.exec(text)?.[1]
  const timeout = /^- loader-timeout-ms: (\d+)$/m.exec(text)?.[1]
  const mapping = /^- registration-error-to-load-failure: (.+)$/m.exec(text)?.[1]
  if (!pattern || !prerelease || !timeout || !mapping) {
    throw new Error('behaviour snapshot is missing a required field')
  }
  return {
    reverseDnsNamePattern: pattern,
    includePrerelease: prerelease === 'true',
    loaderTimeoutMs: Number(timeout),
    reasonToStatus: mapping,
  }
}

export function checkBehaviourContract(root: string, overrides: SourceOverrides = {}): Result {
  const registerPath = resolve(root, 'packages/extension-api/src/register-extension.ts')
  const loaderPath = resolve(root, 'apps/api/src/extensions/loader.ts')
  const snapshotPath = resolve(root, 'packages/extension-api/contract-behaviour.snapshot.md')
  const registerSource = overrides.registerSource ?? readFileSync(registerPath, 'utf8')
  const loaderSource = overrides.loaderSource ?? readFileSync(loaderPath, 'utf8')
  const errors: string[] = []
  try {
    const actual = extractBehaviourContract({ registerSource, loaderSource })
    const expected = parseGolden(readFileSync(snapshotPath, 'utf8'))
    const labels: Record<keyof BehaviourContract, string> = {
      reverseDnsNamePattern: 'REVERSE_DNS_NAME_PATTERN',
      includePrerelease: 'includePrerelease',
      loaderTimeoutMs: 'DEFAULT_TIMEOUT_MS',
      reasonToStatus: 'registration-error-to-load-failure',
    }
    for (const key of Object.keys(actual) as Array<keyof BehaviourContract>) {
      if (actual[key] !== expected[key])
        errors.push(`${labels[key]} drifted from contract snapshot`)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

export function renderBehaviourSnapshot(contract: BehaviourContract): string {
  return (
    `# Extension API contract behaviour snapshot\n\n` +
    `- reverse-dns-name-pattern: \`${contract.reverseDnsNamePattern}\`\n` +
    `- include-prerelease: ${contract.includePrerelease}\n` +
    `- loader-timeout-ms: ${contract.loaderTimeoutMs}\n` +
    `- registration-error-to-load-failure: ${contract.reasonToStatus}\n`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkBehaviourContract(process.cwd())
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('check-extension-api-behaviour: pinned definitions match — OK\n')
  }
}
