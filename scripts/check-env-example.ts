#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Read .env.example
const envExamplePath = resolve(process.cwd(), '.env.example')
const envExampleContent = readFileSync(envExamplePath, 'utf-8')

const envExampleKeys = new Set<string>()
for (const line of envExampleContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const key = trimmed.split('=')[0]?.trim()
  if (key) envExampleKeys.add(key)
}

const envSchemaPath = resolve(process.cwd(), 'apps/api/src/config/env.ts')
const envSchemaContent = readFileSync(envSchemaPath, 'utf-8')
const schemaKeys = new Set<string>()
for (const line of envSchemaContent.split('\n')) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*):/)
  if (match?.[1]) {
    schemaKeys.add(match[1])
  }
}

if (envExampleKeys.size === 0 || schemaKeys.size === 0) {
  process.stderr.write('ERROR: Unable to read required env keys from .env.example or env schema\n')
  process.exit(1)
}

const missingInExample = [...schemaKeys].filter((key) => !envExampleKeys.has(key))
const requiredMfaKeys = [
  'MFA_TOTP_ISSUER',
  'MFA_TOTP_PERIOD_SECONDS',
  'MFA_TOTP_DIGITS',
  'MFA_TOTP_WINDOW',
  'MFA_RECOVERY_CODE_COUNT',
  'MFA_RECOVERY_CODE_BCRYPT_COST',
  'TOTP_USED_CODES_TTL_MINUTES',
  'TOTP_REPLAY_HMAC_SECRET',
]
const missingMfaKeys = requiredMfaKeys.filter((key) => !envExampleKeys.has(key))
if (missingInExample.length > 0) {
  process.stderr.write('ERROR: .env.example and env schema keys are out of sync\n')
  if (missingInExample.length > 0) {
    process.stderr.write(`  Missing in .env.example: ${missingInExample.join(', ')}\n`)
  }
  process.exit(1)
}
if (missingMfaKeys.length > 0) {
  process.stderr.write('ERROR: .env.example is missing Story 1.8 MFA keys\n')
  process.stderr.write(`  Missing MFA keys: ${missingMfaKeys.join(', ')}\n`)
  process.exit(1)
}

process.stdout.write(
  `check-env-example: schema keys verified in .env.example (${schemaKeys.size}) — OK\n`
)
