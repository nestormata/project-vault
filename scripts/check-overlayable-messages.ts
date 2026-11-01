#!/usr/bin/env tsx
/**
 * Story 72.19 (CentralizeMe request R4): PV's unit tests do not write the text of an overlayable
 * message key, and the mock UI pack overlays every such key.
 *
 *   tsx scripts/check-overlayable-messages.ts [--web <dir>]
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkOverlayableMessagesGuard } from './lib/overlayable-messages-guard.js'
import { reportGuard } from './lib/nav-guards.js'

export function run(args: readonly string[]): number {
  const index = args.indexOf('--web')
  const webRoot = resolve(index === -1 ? 'apps/web' : (args[index + 1] ?? 'apps/web'))
  const result = checkOverlayableMessagesGuard(webRoot)
  const ok = `check-overlayable-messages: ${result.keys} keys x ${result.locales} locales, ${result.tests} unit tests scanned — OK`
  return reportGuard(result.problems, ok, 'overlayable messages')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2))
}
