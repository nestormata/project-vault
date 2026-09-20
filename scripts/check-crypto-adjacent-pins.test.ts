import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import {
  findWorkspacePackageJsonPaths,
  parseWorkspaceOverrides,
  parseWorkspacePackagesGlobs,
  scanCryptoAdjacentPins,
} from './check-crypto-adjacent-pins.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makeFixtureRoot = useFixtureRoots('crypto-adjacent-pins-', ['apps', 'packages', '.github'])

const WORKSPACE_YAML_REL = 'pnpm-workspace.yaml'
const DEPENDABOT_YML_REL = '.github/dependabot.yml'
const ROOT_PACKAGE_JSON_REL = 'package.json'
const SVC_PACKAGE_JSON_REL = 'apps/svc/package.json'
const LIB_PACKAGE_JSON_REL = 'packages/lib/package.json'
const GROUP_CRYPTO_ADJACENT = 'crypto-adjacent'
const GROUP_PNPM_WORKSPACE = 'pnpm-workspace'
const VIOLATION_KIND_DEPENDABOT = 'dependabot-cross-check'

/** A clean, fully-compliant `.github/dependabot.yml` fixture — the two group lists both match the
 * real canonical list exactly (argon2, bcrypt, @fastify/jwt, fast-jwt, otpauth). */
const CLEAN_DEPENDABOT_YML = `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      crypto-adjacent:
        patterns:
          - "argon2"
          - "bcrypt"
          - "@fastify/jwt"
          - "fast-jwt"
          - "otpauth"
        labels:
          - "crypto-adjacent"
      pnpm-workspace:
        patterns:
          - "*"
        exclude-patterns:
          - "argon2"
          - "bcrypt"
          - "@fastify/jwt"
          - "fast-jwt"
          - "otpauth"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
`

const CLEAN_WORKSPACE_YAML = `packages:
  - "apps/*"
  - "packages/*"
`

function writeCleanBaseFixture(root: string, appDeps: Record<string, string> = {}): void {
  writeFixture(root, WORKSPACE_YAML_REL, CLEAN_WORKSPACE_YAML)
  writeFixture(root, DEPENDABOT_YML_REL, CLEAN_DEPENDABOT_YML)
  writeFixture(
    root,
    ROOT_PACKAGE_JSON_REL,
    JSON.stringify({ name: 'root', private: true }, null, 2)
  )
  writeFixture(
    root,
    SVC_PACKAGE_JSON_REL,
    JSON.stringify(
      {
        name: 'svc',
        dependencies: {
          argon2: '0.45.1',
          bcrypt: '6.0.0',
          '@fastify/jwt': '10.2.2',
          'fast-jwt': '6.3.3',
          otpauth: '9.5.2',
          ...appDeps,
        },
      },
      null,
      2
    )
  )
}

describe('parseWorkspacePackagesGlobs', () => {
  it('parses a simple block-style packages: list', () => {
    expect(parseWorkspacePackagesGlobs('packages:\n  - "apps/*"\n  - "packages/*"\n')).toEqual([
      'apps/*',
      'packages/*',
    ])
  })

  it('returns undefined (fail closed) when no packages: block exists', () => {
    expect(parseWorkspacePackagesGlobs('overrides:\n  foo: 1.0.0\n')).toBeUndefined()
  })
})

describe('parseWorkspaceOverrides', () => {
  it('parses a simple block-style overrides: map', () => {
    const map = parseWorkspaceOverrides('overrides:\n  tsx: 4.21.1\n  "@fastify/static": ^10.1.1\n')
    expect(map.get('tsx')).toBe('4.21.1')
    expect(map.get('@fastify/static')).toBe('^10.1.1')
  })

  it('returns an empty map when no overrides: block exists', () => {
    expect(parseWorkspaceOverrides('packages:\n  - "apps/*"\n').size).toBe(0)
  })
})

describe('findWorkspacePackageJsonPaths', () => {
  it('derives workspace package.json paths from a nonstandard glob (e.g. tools/*), not a hardcoded apps/*|packages/*|fixtures/* literal', () => {
    const root = makeFixtureRoot()
    writeFixture(root, WORKSPACE_YAML_REL, 'packages:\n  - "tools/*"\n')
    writeFixture(root, ROOT_PACKAGE_JSON_REL, '{"name":"root"}')
    writeFixture(root, 'tools/widget/package.json', '{"name":"widget"}')

    const paths = findWorkspacePackageJsonPaths(root)
    expect(paths).toContain(resolve(root, 'package.json'))
    expect(paths).toContain(resolve(root, 'tools/widget/package.json'))
  })

  it('returns undefined (fail closed) when pnpm-workspace.yaml is missing', () => {
    const root = makeFixtureRoot()
    expect(findWorkspacePackageJsonPaths(root)).toBeUndefined()
  })
})

describe('scanCryptoAdjacentPins', () => {
  it('passes clean when every crypto-adjacent package is exact-pinned everywhere, overrides are clean, and dependabot.yml matches', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)

    expect(scanCryptoAdjacentPins(root)).toEqual({ violations: [] })
  })

  it('flags a caret-prefixed crypto-adjacent package, naming the package and its version', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      SVC_PACKAGE_JSON_REL,
      JSON.stringify(
        {
          name: 'svc',
          dependencies: {
            argon2: '0.45.1',
            bcrypt: '^6.0.0',
            '@fastify/jwt': '10.2.2',
            'fast-jwt': '6.3.3',
            otpauth: '9.5.2',
          },
        },
        null,
        2
      )
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ kind: 'pin', packageName: 'bcrypt', version: '"^6.0.0"' })
  })

  it.each(['~6.0.0', '>=6.0.0', '*', '6.x', '6.0.0 - 6.1.0', 'workspace:*'])(
    'flags range-operator/non-exact variant %s',
    (badVersion) => {
      const root = makeFixtureRoot()
      writeCleanBaseFixture(root)
      writeFixture(
        root,
        SVC_PACKAGE_JSON_REL,
        JSON.stringify(
          {
            name: 'svc',
            dependencies: {
              argon2: '0.45.1',
              bcrypt: badVersion,
              '@fastify/jwt': '10.2.2',
              'fast-jwt': '6.3.3',
              otpauth: '9.5.2',
            },
          },
          null,
          2
        )
      )

      const { violations } = scanCryptoAdjacentPins(root)
      expect(violations.some((v) => v.kind === 'pin' && v.packageName === 'bcrypt')).toBe(true)
    }
  )

  it.each(['', null, 'git+https://example.com/bcrypt.git'])(
    'flags version-string edge value %s (empty/null/git-URL) rather than false-passing it',
    (edgeVersion) => {
      const root = makeFixtureRoot()
      writeCleanBaseFixture(root)
      writeFixture(
        root,
        SVC_PACKAGE_JSON_REL,
        JSON.stringify(
          {
            name: 'svc',
            dependencies: {
              argon2: '0.45.1',
              bcrypt: edgeVersion,
              '@fastify/jwt': '10.2.2',
              'fast-jwt': '6.3.3',
              otpauth: '9.5.2',
            },
          },
          null,
          2
        )
      )

      const { violations } = scanCryptoAdjacentPins(root)
      expect(violations.some((v) => v.kind === 'pin' && v.packageName === 'bcrypt')).toBe(true)
    }
  )

  it('ignores a non-crypto-adjacent package with a caret range (scoped, not a blanket no-carets rule)', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root, { eslint: '^10.10.0' })

    expect(scanCryptoAdjacentPins(root)).toEqual({ violations: [] })
  })

  it('does not false-positive on a scoped-package substring collision (@fastify/jwt vs @fastify/jwt-extra)', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root, { '@fastify/jwt-extra': '^1.0.0' })

    expect(scanCryptoAdjacentPins(root)).toEqual({ violations: [] })
  })

  it('does not false-positive when a canonical-list package is simply absent from a given package.json', () => {
    const root = makeFixtureRoot()
    writeFixture(root, WORKSPACE_YAML_REL, CLEAN_WORKSPACE_YAML)
    writeFixture(root, DEPENDABOT_YML_REL, CLEAN_DEPENDABOT_YML)
    writeFixture(root, ROOT_PACKAGE_JSON_REL, '{"name":"root"}')
    writeFixture(
      root,
      SVC_PACKAGE_JSON_REL,
      JSON.stringify({ name: 'svc', dependencies: { zod: '^4.0.0' } }, null, 2)
    )

    expect(scanCryptoAdjacentPins(root)).toEqual({ violations: [] })
  })

  it('catches a second, non-compliant occurrence of a package even when the first occurrence found is compliant', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    // A second workspace member re-declares bcrypt with a caret range.
    writeFixture(
      root,
      LIB_PACKAGE_JSON_REL,
      JSON.stringify({ name: 'lib', dependencies: { bcrypt: '^6.0.0' } }, null, 2)
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(
      violations.some(
        (v) => v.kind === 'pin' && v.packageName === 'bcrypt' && v.file.includes('packages/lib')
      )
    ).toBe(true)
  })

  it('fails closed on a malformed package.json rather than skipping it silently', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(root, LIB_PACKAGE_JSON_REL, '{ not valid json')

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations.some((v) => v.kind === 'pin' && v.file.includes('packages/lib'))).toBe(true)
  })

  it('flags a canonical-list package that appears in pnpm-workspace.yaml overrides:, even with an exact-pin value', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      'pnpm-workspace.yaml',
      `${CLEAN_WORKSPACE_YAML}overrides:\n  argon2: 0.45.1\n`
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'override', packageName: 'argon2', overrideValue: '0.45.1' })
    )
  })

  it('fails loudly (does not silently pass) when dependabot.yml is missing the crypto-adjacent group entirely', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      DEPENDABOT_YML_REL,
      `version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n`
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(
      violations.some(
        (v) => v.kind === VIOLATION_KIND_DEPENDABOT && v.group === GROUP_CRYPTO_ADJACENT
      )
    ).toBe(true)
  })

  it('fails loudly when groups.pnpm-workspace.exclude-patterns is reformatted to flow-style rather than silently treating it as an empty (matching) list', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      DEPENDABOT_YML_REL,
      `version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      crypto-adjacent:
        patterns:
          - "argon2"
          - "bcrypt"
          - "@fastify/jwt"
          - "fast-jwt"
          - "otpauth"
      pnpm-workspace:
        patterns: ["*"]
        exclude-patterns: [argon2, bcrypt, "@fastify/jwt", fast-jwt, otpauth]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
`
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(
      violations.some(
        (v) => v.kind === VIOLATION_KIND_DEPENDABOT && v.group === GROUP_PNPM_WORKSPACE
      )
    ).toBe(true)
  })

  it('flags a mismatch when dependabot.yml groups.crypto-adjacent.patterns is missing a canonical-list package', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      DEPENDABOT_YML_REL,
      CLEAN_DEPENDABOT_YML.replace('          - "otpauth"\n        labels:', '        labels:')
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(
      violations.some(
        (v) => v.kind === VIOLATION_KIND_DEPENDABOT && v.group === GROUP_CRYPTO_ADJACENT
      )
    ).toBe(true)
  })

  it('the real repository state passes cleanly today', () => {
    expect(scanCryptoAdjacentPins(repositoryRoot)).toEqual({ violations: [] })
  })
})

describe('check-crypto-adjacent-pins CLI', () => {
  const script = resolve(repositoryRoot, 'scripts/check-crypto-adjacent-pins.ts')
  const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

  it('exits non-zero and names the offending package + version on a fixture with a reintroduced range (RED case proof)', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      SVC_PACKAGE_JSON_REL,
      JSON.stringify(
        {
          name: 'svc',
          dependencies: {
            argon2: '0.45.1',
            bcrypt: '^6.0.0',
            '@fastify/jwt': '10.2.2',
            'fast-jwt': '6.3.3',
            otpauth: '9.5.2',
          },
        },
        null,
        2
      )
    )

    let stderr = ''
    let threw = false
    try {
      execFileSync(process.execPath, ['--import', tsxLoader, script], { cwd: root, stdio: 'pipe' })
    } catch (error) {
      threw = true
      stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    }
    expect(threw).toBe(true)
    expect(stderr).toContain('bcrypt')
    expect(stderr).toContain('^6.0.0')
  })

  it('exits zero against the real repository state', () => {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, script], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    }).toString()
    expect(stdout).toContain('check-crypto-adjacent-pins')
  })
})
