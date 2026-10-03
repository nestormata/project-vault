// @pv-guard monolithic-region
// @pv-scope pv-originated-only
//
// Story 68.10 AC-4 (ADR 0007 guardrail 1, design section 6): a region marked
// `<!-- @region <name> -->` in a PV-originated `.svelte` file must be a component or contain one,
// so it can be replaced on its own through the M4 registry and `pv-original:`. "A component" is a
// capitalized tag (or dotted member) whose binding is imported from a `.svelte` file in the same
// file's scripts, a `<svelte:component>`, or a `{@render}` marked node. `<InjectionPoint>` never
// counts, otherwise 68-4's required point would make the rule vacuous. A region that is only plain
// HTML, text and a point is monolithic.
//
// The rule checks REPLACEABILITY, not size: a region wrapped in a trivial component passes (a known
// limit, whether that extraction is meaningful is 69.5's componentization audit). There is no
// suppression syntax, no baseline and no allow-list of region names. Files a composition lock
// records as CM's are exempt by provenance (the caller passes the list), nothing else is.
//
// Ships with web-host (`guards/monolithic-region.js`, registry kind "script"), so `pv-verify` runs
// the same rule over a composed tree. Imports only `node:`, `svelte/compiler` and the shared walker.
import { readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { childrenOf, parseRegions, type Node } from './region-markup.js'
import { walkSvelte } from './svelte-files.js'

export interface MonolithicFinding {
  line: number
  message: string
}

export interface FileScan {
  regions: number
  findings: MonolithicFinding[]
}

export interface TreeFinding extends MonolithicFinding {
  file: string
}

export interface TreeScan {
  files: number
  /** Files left out because the lock records them as CM's (not part of `files`). */
  exempted: number
  regions: number
  findings: TreeFinding[]
}

const INJECTION_POINT = 'InjectionPoint'
const TEST_SUPPORT = /(^|\/)src\/lib\/test\//
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/

function isPointImport(source: string | undefined): boolean {
  return source?.split('/').at(-1) === `${INJECTION_POINT}.svelte`
}

function isComponentUse(node: Node, imports: ReadonlyMap<string, string>): boolean {
  if (node.type === 'SvelteComponent') return true
  if (node.type !== 'Component' || node.name === undefined) return false
  const binding = node.name.split('.')[0] ?? ''
  const source = imports.get(binding)
  if (node.name === INJECTION_POINT || isPointImport(source)) return false
  return source !== undefined
}

function containsComponent(node: unknown, imports: ReadonlyMap<string, string>): boolean {
  if (Array.isArray(node)) return node.some((child) => containsComponent(child, imports))
  if (node === null || typeof node !== 'object') return false
  if (isComponentUse(node as Node, imports)) return true
  return childrenOf(node as Node).some((child) => containsComponent(child, imports))
}

function isReplaceable(node: Node, imports: ReadonlyMap<string, string>): boolean {
  return node.type === 'RenderTag' || containsComponent(node, imports)
}

/** Scans one `.svelte` source. A file the compiler cannot parse is a finding: an unparseable file
 * must never hide a region (fail closed). */
export function scanMonolithicRegions(source: string, file = '<source>'): FileScan {
  let parsed
  try {
    parsed = parseRegions(source, file, { requirePoint: false })
  } catch (error) {
    const reason = (error as Error).message.split('\n')[0] ?? 'parse error'
    return {
      regions: 0,
      findings: [
        {
          line: 1,
          message: `file could not be parsed, so its regions were not checked: ${reason}`,
        },
      ],
    }
  }
  const findings: MonolithicFinding[] = parsed.regionProblems.map((problem) => ({ ...problem }))
  for (const region of parsed.regions) {
    if (isReplaceable(region.node, parsed.svelteImports)) continue
    findings.push({
      line: region.line,
      message: `@region "${region.name}" is a monolithic region (neither a component nor does it contain one)`,
    })
  }
  findings.sort((a, b) => a.line - b.line)
  return { regions: parsed.regions.length, findings }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Scans every `.svelte` file under `<appRoot>/src` (test support and test files excluded, like the
 * 68-4 coverage guard). `exemptFiles` are app-relative paths the lock records as CM's. */
export function scanMonolithicRegionsTree(
  appRoot: string,
  exemptFiles: readonly string[] = []
): TreeScan {
  const exempt = new Set(exemptFiles)
  const root = resolve(appRoot)
  const result: TreeScan = { files: 0, exempted: 0, regions: 0, findings: [] }
  for (const absolute of walkSvelte(join(root, 'src'))) {
    const rel = toPosix(relative(root, absolute))
    if (TEST_SUPPORT.test(rel) || TEST_FILE.test(rel)) continue
    if (exempt.has(rel)) {
      result.exempted += 1
      continue
    }
    const scan = scanMonolithicRegions(readFileSync(absolute, 'utf8'), absolute)
    result.files += 1
    result.regions += scan.regions
    result.findings.push(...scan.findings.map((finding) => ({ ...finding, file: rel })))
  }
  return result
}

/** The script-guard contract (`manifests/guards.json`, kind "script"). `exemptFiles` carries the
 * lock's CM-originated paths (the kit passes them to `pv-originated-only` guards). */
export function runGuard(
  appRoot: string,
  exemptFiles: readonly string[] = []
): { file: string; message: string }[] {
  return scanMonolithicRegionsTree(appRoot, exemptFiles).findings.map((finding) => ({
    file: finding.file,
    message: `${finding.file}:${finding.line}: ${finding.message}`,
  }))
}
