import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import {
  findWorkspacePackageJsonPaths,
  parseCodeowners,
  parseWorkspaceOverrides,
  parseWorkspacePackagesGlobs,
  scanCryptoAdjacentPins,
} from './check-crypto-adjacent-pins.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makeFixtureRoot = useFixtureRoots('crypto-adjacent-pins-', ['apps', 'packages', '.github'])

const WORKSPACE_YAML_REL = 'pnpm-workspace.yaml'
const DEPENDABOT_YML_REL = '.github/dependabot.yml'
const CODEOWNERS_REL = '.github/CODEOWNERS'
const ROOT_PACKAGE_JSON_REL = 'package.json'
const SVC_PACKAGE_JSON_REL = 'apps/svc/package.json'
const LIB_PACKAGE_JSON_REL = 'packages/lib/package.json'
const GROUP_CRYPTO_ADJACENT = 'crypto-adjacent'
const GROUP_PNPM_WORKSPACE = 'pnpm-workspace'
const VIOLATION_KIND_DEPENDABOT = 'dependabot-cross-check'
const VIOLATION_KIND_CODEOWNERS = 'codeowners-coverage'
const MINIMAL_ROOT_PACKAGE_JSON = '{"name":"root"}'
const EXPECTED_CODEOWNER = '@nestormata'
const SVC_CODEOWNERS_PATH = '/apps/svc/package.json'
const DEPENDABOT_CODEOWNERS_PATH = '/.github/dependabot.yml'
const SVC_CODEOWNERS_LINE = `${SVC_CODEOWNERS_PATH}                     ${EXPECTED_CODEOWNER}\n`

/** Every fixed infra path's own `CODEOWNERS` line, shared by all fixtures below so the path list
 * only needs to be kept in one place — a violation-injecting test then adds/removes/mutates just
 * the one line it cares about rather than re-typing the whole block each time. */
const FIXED_CODEOWNERS_LINES =
  `${DEPENDABOT_CODEOWNERS_PATH}                    ${EXPECTED_CODEOWNER}\n` +
  `/.github/CODEOWNERS                        ${EXPECTED_CODEOWNER}\n` +
  `/scripts/lib/crypto-adjacent-packages.ts   ${EXPECTED_CODEOWNER}\n` +
  `/scripts/check-crypto-adjacent-pins.ts     ${EXPECTED_CODEOWNER}\n` +
  `/scripts/check-crypto-adjacent-pins.test.ts ${EXPECTED_CODEOWNER}\n`

/** A clean, fully-compliant `.github/CODEOWNERS` fixture — covers the fixed infra paths this
 * script always requires plus the one dynamic package.json path (`apps/svc/package.json`) that
 * `writeCleanBaseFixture` declares all five canonical packages in. */
const CLEAN_CODEOWNERS = `${FIXED_CODEOWNERS_LINES}${SVC_CODEOWNERS_LINE}`

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
  writeFixture(root, CODEOWNERS_REL, CLEAN_CODEOWNERS)
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
    writeFixture(root, ROOT_PACKAGE_JSON_REL, MINIMAL_ROOT_PACKAGE_JSON)
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
    // No dynamic package.json path is expected in CODEOWNERS here since svc declares no
    // canonical-list package — only the fixed infra paths are required.
    writeFixture(root, CODEOWNERS_REL, FIXED_CODEOWNERS_LINES)
    writeFixture(root, ROOT_PACKAGE_JSON_REL, MINIMAL_ROOT_PACKAGE_JSON)
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
    writeFixture(root, WORKSPACE_YAML_REL, `${CLEAN_WORKSPACE_YAML}overrides:\n  argon2: 0.45.1\n`)

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'override', packageName: 'argon2', overrideValue: '0.45.1' })
    )
  })

  it('flags a canonical-list package overridden via pnpm\'s version-range-qualified key syntax (a quoted key containing a space, e.g. "argon2@>=0.40.0 <0.46.0"), not just a bare-name key', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      WORKSPACE_YAML_REL,
      `${CLEAN_WORKSPACE_YAML}overrides:\n  "argon2@>=0.40.0 <0.46.0": 0.45.1\n`
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'override', packageName: 'argon2' })
    )
  })

  it('flags a scoped canonical-list package overridden via a version-range-qualified quoted key (e.g. "@fastify/jwt@>=10.0.0 <11.0.0")', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      WORKSPACE_YAML_REL,
      `${CLEAN_WORKSPACE_YAML}overrides:\n  "@fastify/jwt@>=10.0.0 <11.0.0": 10.2.2\n`
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: 'override', packageName: '@fastify/jwt' })
    )
  })

  it('flags a crypto-adjacent package declared under peerDependencies with a range (not just dependencies/devDependencies)', () => {
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
            bcrypt: '6.0.0',
            '@fastify/jwt': '10.2.2',
            'fast-jwt': '6.3.3',
            otpauth: '9.5.2',
          },
          peerDependencies: { bcrypt: '^6.0.0' },
        },
        null,
        2
      )
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations.some((v) => v.kind === 'pin' && v.packageName === 'bcrypt')).toBe(true)
  })

  it('fails closed (does not silently under-scan) when pnpm-workspace.yaml declares an unsupported glob shape (recursive ** or a negation pattern)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, WORKSPACE_YAML_REL, 'packages:\n  - "packages/**"\n')
    writeFixture(root, DEPENDABOT_YML_REL, CLEAN_DEPENDABOT_YML)
    writeFixture(root, ROOT_PACKAGE_JSON_REL, MINIMAL_ROOT_PACKAGE_JSON)

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations.some((v) => v.kind === 'pin' && v.file === WORKSPACE_YAML_REL)).toBe(true)
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

  // --- Story 42.5 AC3: CODEOWNERS/canonical-list sync gate --------------------------------------

  it('passes clean when CODEOWNERS covers every fixed infra path and every canonical-package-declaring package.json', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)

    expect(scanCryptoAdjacentPins(root)).toEqual({ violations: [] })
  })

  it('fails when CODEOWNERS is missing an entry for a package.json that declares a canonical-list package', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    // Drop the one dynamic entry, keep the fixed infra paths.
    writeFixture(root, CODEOWNERS_REL, FIXED_CODEOWNERS_LINES)

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: VIOLATION_KIND_CODEOWNERS, path: SVC_CODEOWNERS_PATH })
    )
  })

  it('fails when CODEOWNERS is missing an entry for a fixed infra path (e.g. dependabot.yml)', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    const withoutDependabotLine = FIXED_CODEOWNERS_LINES.split('\n')
      .filter((line) => !line.startsWith(DEPENDABOT_CODEOWNERS_PATH))
      .join('\n')
    writeFixture(root, CODEOWNERS_REL, `${withoutDependabotLine}\n${SVC_CODEOWNERS_LINE}`)

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({
        kind: VIOLATION_KIND_CODEOWNERS,
        path: DEPENDABOT_CODEOWNERS_PATH,
      })
    )
  })

  it('fails when a matching CODEOWNERS entry names the wrong owner token', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    writeFixture(
      root,
      CODEOWNERS_REL,
      CLEAN_CODEOWNERS.replace(
        SVC_CODEOWNERS_LINE,
        '/apps/svc/package.json                     @someone-else\n'
      )
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({ kind: VIOLATION_KIND_CODEOWNERS, path: SVC_CODEOWNERS_PATH })
    )
  })

  it('fails when a canonical-list package gains a new declaring package.json with no corresponding CODEOWNERS entry (drift/rename detection)', () => {
    const root = makeFixtureRoot()
    writeCleanBaseFixture(root)
    // A second workspace member starts declaring a canonical-list package but CODEOWNERS is not
    // updated — this simulates both "a 6th canonical package is added to a new file" and "an
    // existing declaring package.json is renamed/moved" (the old entry stops matching, the new
    // live path has none), per AC3's edge examples.
    writeFixture(
      root,
      LIB_PACKAGE_JSON_REL,
      JSON.stringify({ name: 'lib', dependencies: { bcrypt: '6.0.0' } }, null, 2)
    )

    const { violations } = scanCryptoAdjacentPins(root)
    expect(violations).toContainEqual(
      expect.objectContaining({
        kind: VIOLATION_KIND_CODEOWNERS,
        path: '/packages/lib/package.json',
      })
    )
  })

  it('fails closed (one violation per expected path) when CODEOWNERS does not exist at all', () => {
    const root = makeFixtureRoot()
    writeFixture(root, WORKSPACE_YAML_REL, CLEAN_WORKSPACE_YAML)
    writeFixture(root, DEPENDABOT_YML_REL, CLEAN_DEPENDABOT_YML)
    writeFixture(root, ROOT_PACKAGE_JSON_REL, MINIMAL_ROOT_PACKAGE_JSON)
    writeFixture(
      root,
      SVC_PACKAGE_JSON_REL,
      JSON.stringify({ name: 'svc', dependencies: { argon2: '0.45.1' } }, null, 2)
    )

    const { violations } = scanCryptoAdjacentPins(root)
    const codeownersViolations = violations.filter((v) => v.kind === VIOLATION_KIND_CODEOWNERS)
    expect(codeownersViolations.length).toBeGreaterThanOrEqual(5)
    expect(codeownersViolations).toContainEqual(
      expect.objectContaining({ path: DEPENDABOT_CODEOWNERS_PATH })
    )
    expect(codeownersViolations).toContainEqual(
      expect.objectContaining({ path: SVC_CODEOWNERS_PATH })
    )
  })
})

describe('parseCodeowners', () => {
  it('parses simple path/owner lines, ignoring comments and blank lines', () => {
    const map = parseCodeowners(
      `# a comment\n\n/apps/api/package.json ${EXPECTED_CODEOWNER}\n/.github/CODEOWNERS   ${EXPECTED_CODEOWNER}\n`
    )
    expect(map.get('/apps/api/package.json')).toEqual([EXPECTED_CODEOWNER])
    expect(map.get('/.github/CODEOWNERS')).toEqual([EXPECTED_CODEOWNER])
  })

  it('returns an empty map for an empty or all-comment file', () => {
    expect(parseCodeowners('# nothing here\n\n').size).toBe(0)
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
