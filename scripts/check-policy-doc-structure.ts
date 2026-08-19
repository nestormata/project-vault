#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const POLICY_RELATIVE_PATH = 'docs/extension-api-versioning-policy.md'
export const POLICY_URL =
  'https://github.com/nestormata/project-vault/blob/main/docs/extension-api-versioning-policy.md'
export const REQUIRED_POLICY_HEADINGS = [
  '## Status',
  '## Scope — what v1 does not answer',
  '## Change classification',
  '## Direction of flow',
  '## Runtime behaviour in the contract',
  '## Semver discipline',
  '## Public surface and the experimental tier',
  '## Deprecation lifecycle',
  '## Notice window',
  '## Known consumers',
  '## Version allocation',
  '## Load-time compatibility gate',
  '## CI version-skew guard',
  '## Supply chain',
  '## Distribution & immutability',
] as const

type Overrides = {
  policyText?: string
  readmeText?: string
  tracked?: boolean
}

export type PolicyCheckResult = { ok: true } | { ok: false; errors: string[] }

function readText(path: string, fallback = ''): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

function policyErrors(policyText: string, tracked: boolean): string[] {
  const errors: string[] = []
  if (!tracked) errors.push(`${POLICY_RELATIVE_PATH} is not git-tracked`)
  if (!policyText) errors.push(`${POLICY_RELATIVE_PATH} does not exist`)
  for (const heading of REQUIRED_POLICY_HEADINGS) {
    if (!policyText.split('\n').some((line) => line.trim() === heading))
      errors.push(`policy document is missing required heading: ${heading}`)
  }
  return errors
}

function readmeErrors(readmeText: string): string[] {
  const errors: string[] = []
  if (!readmeText.includes(POLICY_URL))
    errors.push(
      'packages/extension-api/README.md must contain the canonical absolute HTTPS policy URL'
    )
  const section = readmeText.match(/## Versioning & Deprecation\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? ''
  if (section.split('\n').filter(Boolean).length > 8)
    errors.push('README Versioning & Deprecation pointer must be no more than 8 non-empty lines')
  return errors
}

function isTracked(root: string): boolean {
  try {
    execFileSync('/usr/bin/git', ['ls-files', '--error-unmatch', POLICY_RELATIVE_PATH], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    })
    return true
  } catch {
    return false
  }
}

export function checkPolicyDocument(root: string, overrides: Overrides = {}): PolicyCheckResult {
  const policyPath = resolve(root, POLICY_RELATIVE_PATH)
  const readmePath = resolve(root, 'packages/extension-api/README.md')
  const policyText = overrides.policyText ?? readText(policyPath)
  const readmeText = overrides.readmeText ?? readText(readmePath)
  const errors = [
    ...policyErrors(policyText, overrides.tracked ?? isTracked(root)),
    ...readmeErrors(readmeText),
  ]
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkPolicyDocument(process.cwd())
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      'check-policy-doc-structure: policy, pointer, and required headings — OK\n'
    )
  }
}
