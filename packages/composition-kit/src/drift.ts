import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffFiles } from './diff.js'
import type { DriftItem } from './overlay.js'

export interface DriftContext {
  /** `pvRelease` of the web-host being composed. */
  hostVersion: string
  /** A previous web-host directory (`--previous-host`), for the true old-to-new PV diff. */
  previousHost?: string
}

function indent(text: string): string {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `    ${line}`)
    .join('\n')
}

function kindLabel(item: DriftItem): string {
  const story = item.story === null ? '' : `, story ${item.story}`
  return `${item.kind}${story}`
}

function previousDiff(item: DriftItem, context: DriftContext): string[] {
  if (context.previousHost === undefined) return []
  const previous = join(context.previousHost, item.hostPath)
  if (!existsSync(previous)) {
    return [
      '  --- previous web-host vs new web-host ---',
      '    the previous web-host does not contain this file',
    ]
  }
  const diff = diffFiles(
    readFileSync(previous),
    readFileSync(item.hostAbs),
    `previous ${item.hostPath}`,
    `web-host ${item.hostPath}`
  )
  return ['  --- previous web-host vs new web-host (unified diff) ---', indent(diff)]
}

/** The report for one drifted file (design section 11). The lock holds only hashes, so the default
 * diff is the CM file against the NEW web-host file: what the override now differs from. */
export function driftReport(item: DriftItem, context: DriftContext): string {
  const head = `DRIFT ${item.key} (${kindLabel(item)})`
  const lines = [
    head,
    `  declared hostSha256: ${item.accepted}   web-host sha256: ${item.actual}   accepted at PV ${item.acceptedAt}, host is PV ${context.hostVersion}`,
    '  --- cm file vs new web-host file (unified diff) ---',
    indent(
      diffFiles(
        readFileSync(item.cmAbs),
        readFileSync(item.hostAbs),
        `cm ${item.key}`,
        `web-host ${item.hostPath}`
      )
    ),
    ...previousDiff(item, context),
  ]
  return lines.join('\n')
}
