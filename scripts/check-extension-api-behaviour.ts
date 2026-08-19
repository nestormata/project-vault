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
  const pattern = sources.registerSource.match(
    /const REVERSE_DNS_NAME_PATTERN\s*=\s*(\/[^\n]+\/)/
  )?.[1]
  const prerelease = sources.registerSource.match(/includePrerelease\s*:\s*(true|false)/)?.[1]
  const timeout = sources.loaderSource.match(/const DEFAULT_TIMEOUT_MS\s*=\s*(\d+)/)?.[1]
  const mapping =
    sources.loaderSource.includes("'incompatible-version'") &&
    sources.loaderSource.includes("'capability_mismatch'")
  if (!pattern || !prerelease || !timeout || !mapping) {
    throw new Error('could not extract one or more contract behaviour definitions')
  }
  return {
    reverseDnsNamePattern: pattern,
    includePrerelease: prerelease === 'true',
    loaderTimeoutMs: Number(timeout),
    reasonToStatus: 'incompatible-version -> capability_mismatch',
  }
}

function parseGolden(text: string): BehaviourContract {
  const pattern = text.match(/^- reverse-dns-name-pattern: `([^`]+)`$/m)?.[1]
  const prerelease = text.match(/^- include-prerelease: (true|false)$/m)?.[1]
  const timeout = text.match(/^- loader-timeout-ms: (\d+)$/m)?.[1]
  const mapping = text.match(/^- registration-error-to-load-failure: (.+)$/m)?.[1]
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
      reasonToStatus: 'incompatible-version -> capability_mismatch',
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
