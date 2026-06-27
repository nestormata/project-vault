#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const filesToCheck = [
  '_bmad-output/implementation-artifacts/1-10-structured-operational-logging-and-metrics.md',
  'apps/api/src/lib/logger.ts',
  'apps/api/src/lib/job-logging.ts',
  'apps/api/src/lib/startup-logging.ts',
  'apps/api/src/plugins/structured-logging.ts',
  'apps/api/src/plugins/http-metrics.ts',
  'apps/api/src/routes/metrics.ts',
  'packages/shared/src/constants/operational-event-types.ts',
]

const riskyPhrases = [
  /audit ready/i,
  /compliance evidence/i,
  /compliance-grade evidence/i,
  /operational audit log/i,
  /audit log operational/i,
]

const boundaryLanguage =
  /\b(not|does not|do not|separate|separate from|distinct|boundary|requires|mistaken|sanity check|verify)\b/i
const failures: string[] = []

for (const file of filesToCheck) {
  const content = readFileSync(resolve(process.cwd(), file), 'utf-8')
  let inFence = false
  content.split('\n').forEach((line, index) => {
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      return
    }
    if (inFence) return
    if (!riskyPhrases.some((phrase) => phrase.test(line))) return
    if (boundaryLanguage.test(line)) return
    failures.push(`${file}:${index + 1}: ${line.trim()}`)
  })
}

if (failures.length > 0) {
  process.stderr.write(
    `ERROR: Operational logging wording may imply audit/compliance evidence:\n${failures
      .map((failure) => `  - ${failure}`)
      .join('\n')}\n`
  )
  process.exit(1)
}

process.stdout.write('check-operational-log-language: operational/audit boundary wording OK\n')
