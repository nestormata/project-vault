#!/usr/bin/env tsx
/**
 * G5 static guard: every rendered user-facing native form control must expose a
 * visible description through aria-describedby. The scanner itself ships with
 * web-host (apps/web/guards/form-guidance.ts, Story 68.9) so a composed tree is
 * scanned with the same rules; this is the repository's thin CLI over it.
 */
import { basename, resolve } from 'node:path'
import {
  scanFormGuidance,
  scanFormGuidanceTree,
  type FormGuidanceFinding,
} from '../apps/web/guards/form-guidance.js'

export { scanFormGuidance, type FormGuidanceFinding }

export function scanWebFormGuidance(rootDir = process.cwd()): FormGuidanceFinding[] {
  const root = resolve(rootDir)
  return scanFormGuidanceTree(resolve(root, 'apps/web/src'), root)
}

function main(): void {
  const findings = scanWebFormGuidance()
  for (const finding of findings) {
    process.stdout.write(
      `[MISSING] ${finding.kind} ${finding.file}:${finding.line}\n` + `  ${finding.message}\n`
    )
  }
  process.stdout.write(`check-form-guidance: ${findings.length} finding(s)\n`)
  if (findings.length > 0) process.exitCode = 1
}

if (basename(process.argv[1] ?? '') === 'check-form-guidance.ts') main()
