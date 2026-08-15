#!/usr/bin/env tsx
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rootLicense = resolve(process.cwd(), 'LICENSE')
const packageLicense = resolve(process.cwd(), 'packages/extension-api/LICENSE')

const rootContents = readFileSync(rootLicense)
const packageContents = readFileSync(packageLicense)

if (!rootContents.equals(packageContents)) {
  process.stderr.write(
    'FATAL: packages/extension-api/LICENSE is stale; copy the repository LICENSE before publishing.\n'
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    'check-extension-api-license-fresh: package LICENSE matches root LICENSE — OK\n'
  )
}
