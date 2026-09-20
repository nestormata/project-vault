#!/usr/bin/env tsx
/**
 * Story 42.3 — exact-pin CI gate for crypto-adjacent dependencies (AC4).
 *
 * Reads `scripts/lib/crypto-adjacent-packages.ts`'s canonical `CRYPTO_ADJACENT_PACKAGES` list (a
 * real TS import — not a re-declared copy) and enforces three things a careless PR could otherwise
 * slip past unnoticed:
 *
 *  1. Every occurrence of a canonical-list package name, in `dependencies` or `devDependencies` of
 *     every workspace `package.json` (root + every directory `pnpm-workspace.yaml`'s own
 *     `packages:` glob resolves to, derived at runtime — not a hardcoded `apps/*`/`packages/*`
 *     literal), must be an exact semver string. This is an ALLOW-list check (the version string
 *     must match `^\d+\.\d+\.\d+(-\S+)?$`), not a deny-list of range-operator characters — so a
 *     `workspace:*`, an empty string, a `null` version, or a git/tarball URL fails closed instead of
 *     silently passing a naive "no `^`/`~`" grep.
 *  2. `pnpm-workspace.yaml`'s `overrides:` block must not name any canonical-list package at all,
 *     regardless of whether the override value itself is a range or an exact pin — per AC2's own
 *     negative example, pinning at the declaration site is the only correct mechanism here; an
 *     override can silently force a resolution above an exactly-pinned `package.json` entry without
 *     that entry's own version string ever changing (Red Team Attack 2 in this story's Dev Notes).
 *  3. `.github/dependabot.yml`'s `groups.crypto-adjacent.patterns` and
 *     `groups.pnpm-workspace.exclude-patterns` must each match the canonical list exactly. YAML
 *     cannot `import` a `.ts` const, so this is a hand-parsed structural cross-check (see this
 *     story's Dev Notes ADR for why a full YAML-parsing dependency was deliberately not added) — and
 *     it fails closed: if the expected block shape cannot be located at all (a rename, a reformat to
 *     flow-style, a missing key), that is reported as a violation, never silently treated as "list is
 *     empty, so it matches nothing, so nothing fails."
 *
 * Pure, DB-free: a static read of `package.json` files, `pnpm-workspace.yaml`, and
 * `.github/dependabot.yml` under the given root — no `pnpm list`/`pnpm why`, no network.
 */
import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CRYPTO_ADJACENT_PACKAGES } from './lib/crypto-adjacent-packages.js'

export type PinViolation = {
  kind: 'pin'
  file: string
  packageName: string
  version: string
  reason: string
}

export type OverrideViolation = {
  kind: 'override'
  packageName: string
  overrideValue: string
}

export type DependabotCrossCheckViolation = {
  kind: 'dependabot-cross-check'
  group: string
  reason: string
}

export type CryptoAdjacentPinViolation =
  PinViolation | OverrideViolation | DependabotCrossCheckViolation

export type CryptoAdjacentPinScanResult = {
  violations: CryptoAdjacentPinViolation[]
}

/** Allow-list of what an "exact pin" looks like — not a deny-list of range-operator characters. */
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const WORKSPACE_YAML_PATH = 'pnpm-workspace.yaml'

// ---------------------------------------------------------------------------------------------
// Workspace package.json enumeration — derived from pnpm-workspace.yaml's own `packages:` glob at
// runtime (Boundary & Edge Case Sweep finding: a hardcoded apps/*|packages/*|fixtures/* literal
// would miss a new workspace root added later, e.g. a nonstandard `tools/*`).
// ---------------------------------------------------------------------------------------------

/** Parses `pnpm-workspace.yaml`'s top-level `packages:` block into its raw glob entries (e.g.
 * `apps/*`, `packages/*`). Returns `undefined` if the block cannot be located at all (fail closed —
 * callers must not treat "no packages: block found" as "workspace has zero packages"). */
export function parseWorkspacePackagesGlobs(yamlContent: string): string[] | undefined {
  const lines = yamlContent.split('\n')
  let inBlock = false
  const globs: string[] = []

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (line.length > 0 && !/^\s/.test(line)) break // dedent to column 0 ends the block

    const match = /^\s{2}-\s*"?([^"\s]+)"?\s*$/.exec(line)
    if (match) globs.push(match[1] as string)
    else if (/^\s{2}\S/.test(line)) break // a non-list-item, indented line also ends the block
  }

  return inBlock ? globs : undefined
}

/** Only a literal directory (no wildcard) or a single trailing `/*` segment is a supported
 * `packages:` glob shape — the one this repo's own `pnpm-workspace.yaml` uses, matching this
 * script's static-file-scan scope (no general glob library). Anything else (a recursive `**`, a
 * mid-string `*`, or a pnpm negation `!pattern`) must fail closed rather than being silently
 * resolved as a literal, near-certainly-nonexistent directory and quietly under-scanned. */
function isSupportedPackagesGlob(glob: string): boolean {
  return /^[^*!]+$/.test(glob) || /^[^*!]+\/\*$/.test(glob)
}

/** Resolves a single supported `packages:` glob entry (e.g. `apps/*`, or a literal directory with
 * no wildcard) to the workspace-member directories it matches under `root`. Callers must check
 * `isSupportedPackagesGlob` first — this function assumes the glob shape is already supported. */
function resolveGlobToDirs(root: string, glob: string): string[] {
  if (glob.endsWith('/*')) {
    const base = resolve(root, glob.slice(0, -2))
    let entries: string[]
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- root is caller-controlled (tests pass a fixture dir, production passes cwd), never user input
      entries = readdirSync(base)
    } catch {
      return []
    }
    return entries
      .map((name) => resolve(base, name))
      .filter((dir) => {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
          return statSync(dir).isDirectory()
        } catch {
          return false
        }
      })
  }
  return [resolve(root, glob)]
}

/** Every workspace `package.json` path (root + every `pnpm-workspace.yaml` glob match) that
 * actually exists on disk, or `undefined` if `pnpm-workspace.yaml` itself, or its `packages:`
 * block, could not be read/parsed (fail closed). */
export function findWorkspacePackageJsonPaths(root: string): string[] | undefined {
  const workspaceYamlPath = resolve(root, WORKSPACE_YAML_PATH)

  let raw: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    raw = readFileSync(workspaceYamlPath, 'utf-8')
  } catch {
    return undefined
  }

  const globs = parseWorkspacePackagesGlobs(raw)
  if (globs === undefined) return undefined
  if (globs.some((glob) => !isSupportedPackagesGlob(glob))) return undefined

  const dirs = [root, ...globs.flatMap((glob) => resolveGlobToDirs(root, glob))]

  const packageJsonPaths: string[] = []
  for (const dir of dirs) {
    const candidate = resolve(dir, 'package.json')
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
      if (statSync(candidate).isFile()) packageJsonPaths.push(candidate)
    } catch {
      // no package.json in this workspace member dir — not an error, just nothing to scan there
    }
  }
  return packageJsonPaths
}

// ---------------------------------------------------------------------------------------------
// package.json pin scanning
// ---------------------------------------------------------------------------------------------

type RawPackageJson = Record<string, unknown>

function loadPackageJson(path: string): RawPackageJson | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    const raw = readFileSync(path, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as RawPackageJson
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Renders a dependency version value for a violation message, handling the non-string edge cases
 * (missing/`null`) the strict allow-list regex also correctly rejects. */
function describeVersion(version: unknown): string {
  if (version === null) return 'null'
  if (typeof version === 'string') return JSON.stringify(version)
  return JSON.stringify(version)
}

const NOT_AN_EXACT_PIN_EXPLANATION =
  'crypto-adjacent packages must be pinned to a bare exact semver version, with no range ' +
  'operator, workspace:/git/tarball reference, or empty/missing value'

/** Checks one dependency field's entries (e.g. `pkg.dependencies`) for non-exact crypto-adjacent
 * pins, appending any found to `violations`. */
function scanDependencyField(
  violations: PinViolation[],
  repoRelativePath: string,
  field: (typeof DEPENDENCY_FIELDS)[number],
  deps: unknown
): void {
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) return

  for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
    if (!CRYPTO_ADJACENT_PACKAGES.includes(name)) continue
    if (typeof version === 'string' && EXACT_SEMVER_PATTERN.test(version)) continue

    violations.push({
      kind: 'pin',
      file: repoRelativePath,
      packageName: name,
      version: describeVersion(version),
      reason:
        `"${name}" in ${field} of ${repoRelativePath} is not an exact pin ` +
        `(got ${describeVersion(version)}) — ${NOT_AN_EXACT_PIN_EXPLANATION}`,
    })
  }
}

function scanPackageJsonPins(rootDir: string, packageJsonPath: string): PinViolation[] {
  const violations: PinViolation[] = []
  const repoRelativePath = packageJsonPath.startsWith(rootDir)
    ? packageJsonPath.slice(rootDir.length).replace(/^\/+/, '')
    : packageJsonPath

  const pkg = loadPackageJson(packageJsonPath)
  if (pkg === undefined) {
    violations.push({
      kind: 'pin',
      file: repoRelativePath,
      packageName: '<file>',
      version: '<unreadable>',
      reason: `${repoRelativePath} could not be read or is not a valid JSON object`,
    })
    return violations
  }

  for (const field of DEPENDENCY_FIELDS) {
    scanDependencyField(violations, repoRelativePath, field, pkg[field])
  }

  return violations
}

// ---------------------------------------------------------------------------------------------
// pnpm-workspace.yaml overrides scanning (Red Team Attack 2 defense)
// ---------------------------------------------------------------------------------------------

/** Parses `pnpm-workspace.yaml`'s top-level `overrides:` block into its raw `{ name: value }`
 * entries. Returns an empty map (not `undefined`) if the block is genuinely absent — an
 * `overrides:` block is optional in this repo's own schema, unlike the `packages:`/dependabot
 * blocks this script also parses, which are always expected to exist.
 *
 * Keys are tried in two shapes: quoted (`"pkg@>=x <y": value`) first, since pnpm's
 * version-range-qualified override syntax embeds a literal space inside the quotes — a plain
 * `[^\s]+` key pattern alone would silently fail to match that line at all and drop the entry
 * (this repo's own `pnpm-workspace.yaml` already has this exact shape: `"minimatch@>=10 <10.2.3"`)
 * — then bare/unquoted (`pkg: value`) as a fallback. */
export function parseWorkspaceOverrides(yamlContent: string): Map<string, string> {
  const overrides = new Map<string, string>()
  const lines = yamlContent.split('\n')
  let inBlock = false

  for (const line of lines) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (line.length > 0 && !/^\s/.test(line)) break

    const quoted = /^\s{2}"([^"]+)"\s*:\s*(.+?)\s*$/.exec(line)
    if (quoted) {
      overrides.set(quoted[1] as string, quoted[2] as string)
      continue
    }
    const bare = /^\s{2}([^"\s:]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (bare) overrides.set(bare[1] as string, bare[2] as string)
  }

  return overrides
}

/** Extracts an override key's base package name, stripping pnpm's optional `@<selector>` version-
 * range qualifier (e.g. `"minimatch@>=10 <10.2.3"` → `minimatch`, `"@fastify/static"` → itself
 * unchanged since a scoped name's leading `@scope/` isn't a selector). A selector qualifier is only
 * ever the *last* `@`-delimited segment and, per pnpm's own override syntax, is never itself scoped
 * (it's a semver range), so splitting on `@` and treating everything before the final `@`-segment as
 * the name is safe for both scoped and unscoped package names. */
function extractOverrideBaseName(key: string): string {
  const atIndex = key.startsWith('@') ? key.indexOf('@', 1) : key.indexOf('@')
  return atIndex === -1 ? key : key.slice(0, atIndex)
}

function scanWorkspaceOverrides(root: string): OverrideViolation[] {
  const workspaceYamlPath = resolve(root, WORKSPACE_YAML_PATH)
  let raw: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    raw = readFileSync(workspaceYamlPath, 'utf-8')
  } catch {
    return []
  }

  const overrides = parseWorkspaceOverrides(raw)
  const byBaseName = new Map<string, string>()
  for (const [key, value] of overrides) {
    byBaseName.set(extractOverrideBaseName(key), value)
  }

  const violations: OverrideViolation[] = []
  for (const name of CRYPTO_ADJACENT_PACKAGES) {
    if (byBaseName.has(name)) {
      violations.push({
        kind: 'override',
        packageName: name,
        overrideValue: byBaseName.get(name) as string,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------------------------
// dependabot.yml cross-check (hand-parsed, per this story's ADR — see Dev Notes)
// ---------------------------------------------------------------------------------------------

/** Collects `- "item"` list entries starting at `lines[startIndex]`, all indented at exactly
 * `itemIndent` spaces, stopping at the first line that doesn't match that shape. */
function collectListItems(lines: string[], startIndex: number, itemIndent: number): string[] {
  const items: string[] = []
  const itemPattern = new RegExp(`^\\s{${itemIndent}}-\\s*"?([^"\\s]+)"?\\s*$`)
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] as string
    const match = itemPattern.exec(line)
    if (!match) break
    items.push(match[1] as string)
  }
  return items
}

/** Finds a `- "item"` list under a `<parentKeyIndent>parentKey:` block that itself contains a
 * `<listKeyIndent>listKey:` line, e.g. `groups: > crypto-adjacent: > patterns: > - "argon2"`. Both
 * the parent key and the list key must be found in order, within a bounded lookahead window, or
 * `undefined` is returned (fail closed — a rename/reformat is a violation, not a silent empty
 * match). */
/** Searches forward from just after a `parentKey:` line (at `startIndex`) for a `listKey:` line
 * nested inside it, stopping (returning `undefined`) if the block dedents back to or past
 * `parentIndent` first — i.e. we've left the parent's block without finding the list key. */
function findListKeyWithinBlock(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  listPattern: RegExp,
  listIndent: number
): string[] | undefined {
  for (let j = startIndex; j < lines.length; j++) {
    const line = lines[j] as string
    if (line.length > 0 && !/^\s/.test(line)) return undefined
    const dedentMatch = /^(\s*)\S/.exec(line)
    if (dedentMatch && (dedentMatch[1] as string).length <= parentIndent) return undefined

    if (listPattern.test(line)) return collectListItems(lines, j + 1, listIndent + 2)
  }
  return undefined
}

function findNestedYamlList(
  content: string,
  parentKey: string,
  parentIndent: number,
  listKey: string,
  listIndent: number
): string[] | undefined {
  const lines = content.split('\n')
  const parentPattern = new RegExp(`^\\s{${parentIndent}}${parentKey}:\\s*$`)
  const listPattern = new RegExp(`^\\s{${listIndent}}${listKey}:\\s*$`)

  for (let i = 0; i < lines.length; i++) {
    if (!parentPattern.test(lines[i] as string)) continue

    const found = findListKeyWithinBlock(lines, i + 1, parentIndent, listPattern, listIndent)
    if (found !== undefined) return found
  }
  return undefined
}

const DEPENDABOT_CROSS_CHECK = 'dependabot-cross-check' as const
const DEPENDABOT_YML_PATH = '.github/dependabot.yml'

/** The two `dependabot.yml` group/list pairs this script cross-checks against the canonical list —
 * data-driven so both are checked identically rather than via two near-duplicate blocks. */
const DEPENDABOT_LIST_TARGETS = [
  { group: 'crypto-adjacent', parentKey: 'crypto-adjacent', listKey: 'patterns' },
  { group: 'pnpm-workspace', parentKey: 'pnpm-workspace', listKey: 'exclude-patterns' },
] as const

function checkDependabotGroupList(
  raw: string,
  target: (typeof DEPENDABOT_LIST_TARGETS)[number],
  canonical: string[]
): DependabotCrossCheckViolation | undefined {
  const found = findNestedYamlList(raw, target.parentKey, 6, target.listKey, 8)
  if (found === undefined) {
    return {
      kind: DEPENDABOT_CROSS_CHECK,
      group: target.group,
      reason:
        `could not locate "groups.${target.parentKey}.${target.listKey}:" in ${DEPENDABOT_YML_PATH} ` +
        'in the expected block-style shape — the group may have been renamed, removed, or ' +
        'reformatted (e.g. to flow-style) without updating this cross-check',
    }
  }

  const sorted = [...found].sort((a, b) => a.localeCompare(b))
  if (JSON.stringify(sorted) === JSON.stringify(canonical)) return undefined

  return {
    kind: DEPENDABOT_CROSS_CHECK,
    group: target.group,
    reason:
      `groups.${target.parentKey}.${target.listKey} (${JSON.stringify(sorted)}) does not match ` +
      `the canonical CRYPTO_ADJACENT_PACKAGES list (${JSON.stringify(canonical)})`,
  }
}

function scanDependabotCrossCheck(root: string): DependabotCrossCheckViolation[] {
  const dependabotPath = resolve(root, DEPENDABOT_YML_PATH)
  let raw: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
    raw = readFileSync(dependabotPath, 'utf-8')
  } catch {
    return [
      {
        kind: DEPENDABOT_CROSS_CHECK,
        group: '<file>',
        reason: `${DEPENDABOT_YML_PATH} could not be read at ${dependabotPath}`,
      },
    ]
  }

  const canonical = [...CRYPTO_ADJACENT_PACKAGES].sort((a, b) => a.localeCompare(b))
  const violations: DependabotCrossCheckViolation[] = []
  for (const target of DEPENDABOT_LIST_TARGETS) {
    const violation = checkDependabotGroupList(raw, target, canonical)
    if (violation) violations.push(violation)
  }
  return violations
}

// ---------------------------------------------------------------------------------------------
// Top-level scan
// ---------------------------------------------------------------------------------------------

export function scanCryptoAdjacentPins(rootDir = process.cwd()): CryptoAdjacentPinScanResult {
  const root = resolve(rootDir)
  const violations: CryptoAdjacentPinViolation[] = []

  const packageJsonPaths = findWorkspacePackageJsonPaths(root)
  if (packageJsonPaths === undefined) {
    violations.push({
      kind: 'pin',
      file: WORKSPACE_YAML_PATH,
      packageName: '<file>',
      version: '<unreadable>',
      reason:
        `${WORKSPACE_YAML_PATH} could not be read, or its "packages:" block could not be located — ` +
        'cannot enumerate workspace package.json files to scan (fail closed)',
    })
  } else {
    for (const packageJsonPath of packageJsonPaths) {
      violations.push(...scanPackageJsonPins(root, packageJsonPath))
    }
  }

  violations.push(...scanWorkspaceOverrides(root))
  violations.push(...scanDependabotCrossCheck(root))

  return { violations }
}

function report(result: CryptoAdjacentPinScanResult): void {
  if (result.violations.length === 0) {
    process.stdout.write(
      'check-crypto-adjacent-pins: all crypto-adjacent packages are exact-pinned, override-free, and Dependabot-grouped correctly — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: crypto-adjacent dependency pin/grouping check failed (Story 42.3 enforcement):\n\n'
  )
  for (const v of result.violations) {
    if (v.kind === 'pin') {
      process.stderr.write(`  - [pin] ${v.reason}\n`)
    } else if (v.kind === 'override') {
      process.stderr.write(
        `  - [override] "${v.packageName}" appears in ${WORKSPACE_YAML_PATH}'s overrides: block ` +
          `(value: ${v.overrideValue}) — crypto-adjacent packages must be pinned at their own ` +
          'declaration site, not via a workspace-wide override (see AC2)\n'
      )
    } else {
      process.stderr.write(`  - [dependabot:${v.group}] ${v.reason}\n`)
    }
  }
  process.stderr.write('\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanCryptoAdjacentPins())
}
