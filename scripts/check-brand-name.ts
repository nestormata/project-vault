#!/usr/bin/env tsx
/**
 * Story 72.16 AC-2: no user-visible string in apps/web hard-codes the product name; it is read from
 * the `brand_name` message (overlay-able by a host), or passed to a message as `{brand}`.
 *
 *   tsx scripts/check-brand-name.ts [--web <dir>]
 */
import { resolve } from 'node:path'
import { checkBrandNameGuard } from './lib/brand-name-guard.js'
import { option, runAsMain } from './lib/cli-io.js'
import { reportGuard } from './lib/nav-guards.js'

export function run(args: readonly string[]): number {
  const webRoot = resolve(option(args, '--web') ?? 'apps/web')
  const result = checkBrandNameGuard(webRoot)
  const ok = `check-brand-name: ${result.files} source files and ${result.messageFiles} catalogues — OK`
  return reportGuard(result.problems, ok, 'product name hard-coded')
}

runAsMain(import.meta.url, run)
