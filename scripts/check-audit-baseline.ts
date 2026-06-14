#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const auditCiPath = resolve(process.cwd(), 'audit-ci.jsonc')
const content = readFileSync(auditCiPath, 'utf-8')

const jsonWithoutComments = content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const config = JSON.parse(jsonWithoutComments) as Record<string, unknown[]>

const today = new Date()
let failed = false

const severities = ['high', 'critical', 'moderate', 'low'] as const
for (const severity of severities) {
  const entries = (config[severity] ?? []) as Record<string, string>[]
  for (const entry of entries) {
    if (!entry['expires']) {
      process.stderr.write(
        `ERROR: audit-ci.jsonc ${severity} entry missing "expires": ${JSON.stringify(entry)}\n`
      )
      failed = true
      continue
    }
    if (!entry['reason'] || entry['reason'].trim() === '') {
      process.stderr.write(
        `ERROR: audit-ci.jsonc ${severity} entry missing "reason": ${JSON.stringify(entry)}\n`
      )
      failed = true
    }
    const expiry = new Date(entry['expires'])
    if (expiry < today) {
      process.stderr.write(
        `ERROR: audit-ci.jsonc ${severity} entry expired on ${entry['expires']}: ${JSON.stringify(entry)}\n`
      )
      failed = true
    }
  }
}

if (failed) {
  process.exit(1)
}

process.stdout.write('audit-ci.jsonc baseline check passed\n')
