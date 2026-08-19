#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const REQUIRED_POLICY_CONTENT: Record<string, readonly string[]> = {
  'AC-1': [
    'https://github.com/nestormata/project-vault/blob/main/docs/extension-api-versioning-policy.md',
    '## Distribution & immutability',
  ],
  'AC-2': ['The Obligation Rule', '| 18', 'CapabilityGate', 'replacesNativeLogin'],
  'AC-3': [
    'Direction determines severity',
    'UIPanelContext',
    'NotificationPayload',
    'AuthResult',
    'ExtensionManifest',
  ],
  'AC-4': [
    'REVERSE_DNS_NAME_PATTERN',
    'includePrerelease',
    'hooksFactory',
    'DEFAULT_TIMEOUT_MS',
    'capability_mismatch',
  ],
  'AC-5': ['Strict SemVer 2.0.0', 'manifest.test.ts:15-20', '[pre-publication-exception]'],
  'AC-6': ['src/index.ts', '@experimental', 'Unstable_', 'zero transitively-unexported'],
  'AC-7': ['@deprecated', 'replacement:', 'earliest-removal:', 'notice-window-ends:'],
  'AC-8': ['90 days', '180 days', 'GitHub Release', 'Notified:'],
  'AC-9': ['allocated **at merge, not at planning**', '23.2', '23.3', 'semver.gt(headVersion'],
  'AC-10': ['host-authoritative', 'semver.subset', "'<' +", 'Story 24.3'],
  'AC-11': ['Story 24.4', 'Reject downgrades', 'fail closed', 'push-to-main'],
  'AC-12': ['api-surface.snapshot.md', 'public contract changed', 'compiler-derived'],
  'AC-13': ['contract-hash:', 'content-based', 'CHANGELOG'],
  'AC-14': ['since:', 'two-gates', 'lower bound'],
  'AC-15': ['permanent', 'attested', 'files` allowlist', 'npm unpublish'],
  'AC-16': ['v1', 'Distribution & immutability', 'Story 23.1'],
  'AC-17': ['centralizeme-sass/docs/adr/0005', 'Story 14.9', 'Story 24.4'],
}

export type PolicyContentResult = { ok: true } | { ok: false; errors: string[] }

export function checkPolicyContent(root: string, policyText?: string): PolicyContentResult {
  const text =
    policyText ?? readFileSync(resolve(root, 'docs/extension-api-versioning-policy.md'), 'utf8')
  const errors: string[] = []
  for (const [ac, fragments] of Object.entries(REQUIRED_POLICY_CONTENT)) {
    for (const fragment of fragments) {
      if (!text.includes(fragment))
        errors.push(`${ac}: policy is missing required content: ${fragment}`)
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkPolicyContent(process.cwd())
  if (!result.ok) {
    process.stderr.write(`${result.errors.join('\n')}\n`)
    process.exitCode = 1
  } else process.stdout.write('check-policy-doc-content: AC content anchors — OK\n')
}
