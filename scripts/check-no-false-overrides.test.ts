import { globSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { parseYaml } from './lib/yaml.js'

// Story 68.2 AC-1: a pnpm override must never make a declared range false. pnpm `overrides` do not
// reach a consumer of a published package (design §2), so a manifest that declares `^7.0.2` while
// the workspace silently installs 6.0.3 lies to every consumer that copies its ranges. Rule: for an
// override whose key is a bare package name (`typescript`, `@fastify/static`), every workspace
// manifest that also declares that package must declare a range that INTERSECTS the override's
// range. Selector overrides (`minimatch@>=10 <10.2.3`) and parent-scoped overrides (`a>b`) only
// patch a transitive version window, so they are exempt by construction, never by a list.

const repositoryRoot = join(import.meta.dirname, '..')
const ROOT_MANIFEST = 'package.json'
const WEB_MANIFEST = 'apps/web/package.json'

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

export interface OverrideKey {
  /** The package the override applies to. */
  name: string
  /** The version selector after `name@`, when the key is version-conditional. */
  selector: string | undefined
  /** True for a parent-scoped key (`parent>child`). */
  parentScoped: boolean
}

export interface Manifest {
  path: string
  json: Record<string, unknown>
}

export interface OverrideViolation {
  override: string
  overrideRange: string
  manifest: string
  field: string
  declared: string
  reason: string
}

const PACKAGE_NAME_RE = /^(@[^/@>]+\/[^@>]+|[^@>]+)/

/** Splits an override key into its package name and optional version selector. */
export function parseOverrideKey(key: string): OverrideKey {
  const match = PACKAGE_NAME_RE.exec(key)
  if (!match?.[1]) throw new Error(`unparseable pnpm override key: ${JSON.stringify(key)}`)
  const name = match[1]
  const rest = key.slice(name.length)
  if (rest === '') return { name, selector: undefined, parentScoped: false }
  if (rest.startsWith('@')) {
    const selector = rest.slice(1)
    // `a@1>b` is still parent-scoped; a selector such as `>=10 <10.2.3` starts with `>` itself.
    const parentScoped = /[^\s<>=]>[^=]/.test(selector)
    return { name, selector, parentScoped }
  }
  return { name, selector: undefined, parentScoped: rest.startsWith('>') }
}

/** True when the declared specifier is a semver range pnpm resolves from the registry. */
function isRegistryRange(spec: string): boolean {
  return semver.validRange(spec) !== null
}

interface DeclaredSpec {
  field: string
  declared: string
}

/** Every registry range a manifest declares for `name`, across all dependency fields. */
function declaredSpecs(manifest: Manifest, name: string): DeclaredSpec[] {
  return Object.entries(manifest.json)
    .filter(([field]) => (DEPENDENCY_FIELDS as readonly string[]).includes(field))
    .flatMap(([field, block]) =>
      Object.entries((block ?? {}) as Record<string, string>)
        .filter(([dependency, declared]) => dependency === name && isRegistryRange(declared))
        .map(([, declared]) => ({ field, declared }))
    )
}

function rangeMismatch(declared: string, overrideRange: string): string | undefined {
  if (!isRegistryRange(overrideRange)) return 'the override value is not a semver range'
  return semver.intersects(declared, overrideRange)
    ? undefined
    : `declared ${declared} never matches the override ${overrideRange}`
}

/** Checks every bare-name override against every manifest that declares the same package. */
export function findFalseOverrides(
  overrides: Record<string, string>,
  manifests: Manifest[]
): OverrideViolation[] {
  return Object.entries(overrides)
    .filter(([key, overrideRange]) => {
      const parsed = parseOverrideKey(key)
      // `-` is pnpm's "remove this dependency" marker, not a version.
      return parsed.selector === undefined && !parsed.parentScoped && overrideRange !== '-'
    })
    .flatMap(([key, overrideRange]) =>
      manifests.flatMap((manifest) =>
        declaredSpecs(manifest, parseOverrideKey(key).name).flatMap(({ field, declared }) => {
          const reason = rangeMismatch(declared, overrideRange)
          return reason === undefined
            ? []
            : [{ override: key, overrideRange, manifest: manifest.path, field, declared, reason }]
        })
      )
    )
}

export function formatViolation(violation: OverrideViolation): string {
  return (
    `${violation.manifest} ${violation.field}.${violation.override}: ${violation.reason} ` +
    `(pnpm-workspace.yaml overrides ${violation.override}: ${violation.overrideRange})`
  )
}

// Every workspace manifest, read by Vite at transform time (literal patterns, see
// ~/specs/project-vault-github-actions-pinning.md "File loading"); `listWorkspaceManifests()`
// below is the independent filesystem listing the test cross-checks it against.
const MANIFEST_CONTENTS: Record<string, string> = import.meta.glob(
  [
    '../package.json',
    '../apps/*/package.json',
    '../packages/*/package.json',
    '../fixtures/*/package.json',
  ],
  { query: '?raw', import: 'default', eager: true }
)

function loadWorkspace(): { overrides: Record<string, string>; packages: string[] } {
  const text = readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
  const parsed = parseYaml(text) as { overrides?: Record<string, string>; packages?: string[] }
  return { overrides: parsed.overrides ?? {}, packages: parsed.packages ?? [] }
}

function listWorkspaceManifests(packageGlobs: string[]): string[] {
  const patterns = [ROOT_MANIFEST, ...packageGlobs.map((glob) => `${glob}/package.json`)]
  return globSync(patterns, { cwd: repositoryRoot, exclude: ['**/node_modules/**'] })
    .map((path) => path.split(sep).join('/'))
    .sort((a, b) => a.localeCompare(b))
}

function loadManifests(): Manifest[] {
  return Object.entries(MANIFEST_CONTENTS)
    .map(([path, text]) => ({
      path: path.replace(/^\.\.\//, ''),
      json: JSON.parse(text) as Record<string, unknown>,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

const manifest = (path: string, json: Record<string, unknown>): Manifest => ({ path, json })

describe('check-no-false-overrides: override key parsing (Story 68.2 AC-1 edge)', () => {
  it('parses bare, scoped and version-selector keys without mis-splitting', () => {
    expect(parseOverrideKey('typescript')).toEqual({
      name: 'typescript',
      selector: undefined,
      parentScoped: false,
    })
    expect(parseOverrideKey('@fastify/static')).toEqual({
      name: '@fastify/static',
      selector: undefined,
      parentScoped: false,
    })
    expect(parseOverrideKey('minimatch@>=10 <10.2.3')).toEqual({
      name: 'minimatch',
      selector: '>=10 <10.2.3',
      parentScoped: false,
    })
    expect(parseOverrideKey('fast-uri@<3.1.7')).toEqual({
      name: 'fast-uri',
      selector: '<3.1.7',
      parentScoped: false,
    })
    expect(parseOverrideKey('@scope/pkg@>=4.0.0 <4.1.4').name).toBe('@scope/pkg')
  })

  it('recognises parent-scoped keys', () => {
    expect(parseOverrideKey('foo>bar').parentScoped).toBe(true)
    expect(parseOverrideKey('foo@1>bar').parentScoped).toBe(true)
  })
})

describe('check-no-false-overrides: rule self-tests (Story 68.2 AC-1)', () => {
  it('fails on the pre-68.2 typescript override, naming both ranges and the manifest', () => {
    const violations = findFalseOverrides({ typescript: '^6.0.3' }, [
      manifest(WEB_MANIFEST, { devDependencies: { typescript: '^7.0.2' } }),
    ])
    expect(violations).toHaveLength(1)
    const message = formatViolation(violations[0] as OverrideViolation)
    expect(message).toContain(WEB_MANIFEST)
    expect(message).toContain('^7.0.2')
    expect(message).toContain('^6.0.3')
  })

  it('passes when the declared range intersects the override', () => {
    expect(
      findFalseOverrides({ typescript: '^6.0.3', tsx: '4.21.1' }, [
        manifest(ROOT_MANIFEST, { devDependencies: { typescript: '^6.0.3', tsx: '4.21.1' } }),
        manifest('packages/x/package.json', { peerDependencies: { typescript: '>=6' } }),
      ])
    ).toEqual([])
  })

  it('checks peerDependencies and optionalDependencies too', () => {
    const violations = findFalseOverrides({ typescript: '^6.0.3' }, [
      manifest('packages/eslint-config/package.json', {
        peerDependencies: { typescript: '^5.0.0' },
      }),
      manifest('packages/y/package.json', { optionalDependencies: { typescript: '^7.0.0' } }),
    ])
    expect(violations.map((violation) => violation.field)).toEqual([
      'peerDependencies',
      'optionalDependencies',
    ])
  })

  it('exempts vulnerability-floor selector overrides by construction', () => {
    expect(
      findFalseOverrides({ 'minimatch@>=10 <10.2.3': '^10.2.5', 'fast-uri@<3.1.7': '^3.1.7' }, [
        manifest(ROOT_MANIFEST, { dependencies: { minimatch: '^9.0.0', 'fast-uri': '^2.0.0' } }),
      ])
    ).toEqual([])
  })

  it('ignores workspace:, link: and file: specifiers, which never resolve from the registry', () => {
    expect(
      findFalseOverrides({ '@project-vault/shared': '^1.0.0' }, [
        manifest(WEB_MANIFEST, {
          dependencies: { '@project-vault/shared': 'workspace:*' },
        }),
      ])
    ).toEqual([])
  })

  it('rejects an override value that is not a semver range', () => {
    const violations = findFalseOverrides({ typescript: 'npm:other@1' }, [
      manifest(ROOT_MANIFEST, { devDependencies: { typescript: '^6.0.3' } }),
    ])
    expect(violations[0]?.reason).toMatch(/not a semver range/)
  })
})

describe('check-no-false-overrides: this repo (Story 68.2 AC-1)', () => {
  const workspace = loadWorkspace()
  const manifests = loadManifests()

  it('loads every workspace manifest (anti-vacuity)', () => {
    expect(manifests.map((entry) => entry.path)).toEqual(listWorkspaceManifests(workspace.packages))
    expect(manifests.map((entry) => entry.path)).toContain(WEB_MANIFEST)
    expect(Object.keys(workspace.overrides).length).toBeGreaterThan(0)
  })

  it('has no override that makes a declared range false', () => {
    expect(findFalseOverrides(workspace.overrides, manifests).map(formatViolation)).toEqual([])
  })
})

describe('check-no-false-overrides: CI wiring (Story 68.2 Task 2.3)', () => {
  const command = 'pnpm vitest run scripts/check-no-false-overrides.test.ts'

  it('runs in ci.yml and in make ci-inner', () => {
    const ci = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    expect(workflowRunCommands(ci)).toContain(command)
    expect(recipeRunsCommand(makeRecipe(makefile, 'ci-inner'), command)).toBe(true)
  })
})
