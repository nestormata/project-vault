import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256Hex } from './hash.js'
import { writeFileAtomic } from './lock.js'
import type { FileSource } from './overlay.js'
import type { ComposePlan } from './plan.js'
import { writeReplacementMap } from './replacement-map.js'

export type Signatures = Map<string, string>

function signatureOf(source: FileSource): string {
  if (source.kind === 'text') return `text:${sha256Hex(source.content)}`
  const stat = statSync(source.abs)
  return `file:${source.abs}:${stat.size}:${stat.mtimeMs}`
}

/** A cheap fingerprint of every planned file (size and mtime for copied files), for diffing. */
export function signaturesOf(plan: ComposePlan): Signatures {
  return new Map([...plan.files].map(([dest, source]) => [dest, signatureOf(source)]))
}

/** Dev mode: brings an already-composed tree in line with a new plan by touching only what
 * changed. A file CM no longer overrides is rewritten from web-host (the PV file is restored); a
 * file that left the plan is deleted. Returns the new signatures. */
export function applyIncremental(
  plan: ComposePlan,
  appRoot: string,
  previous: Signatures
): Signatures {
  const next = signaturesOf(plan)
  for (const [dest, source] of plan.files) {
    if (previous.get(dest) === next.get(dest)) continue
    const target = join(appRoot, dest)
    mkdirSync(dirname(target), { recursive: true })
    if (source.kind === 'file') copyFileSync(source.abs, target)
    else writeFileSync(target, source.content)
  }
  for (const dest of previous.keys()) {
    if (!next.has(dest)) rmSync(join(appRoot, dest), { force: true })
  }
  if (plan.replacementMapText !== undefined) writeReplacementMap(appRoot, plan.replacementMapText)
  if (plan.lockText !== undefined) writeFileAtomic(plan.lockPath, plan.lockText)
  return next
}
