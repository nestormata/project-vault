import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkCompatibility,
  checkRuntimeDependencies,
  resolveInstalledVersion,
  validateTuple,
} from './compat.js'
import type { CompatibilityTuple } from './types.js'

const PACKAGE_JSON = 'package.json'

const TUPLE: CompatibilityTuple = {
  schemaVersion: 1,
  pvRelease: '1.5.0',
  extensionApiVersion: '3.25.0',
  kitVersion: '0.1.0',
  toolchain: { kit: '2.70.3', svelte: '5.57.1', vite: '8.3.1', typescript: '6.0.3' },
  apiImageTag: 'ghcr.io/nestormata/project-vault/api:1.5.0',
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function install(root: string, name: string, version: string): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, PACKAGE_JSON), JSON.stringify({ name, version }))
}

function makeApp(
  versions: Record<string, string>,
  dependencies: Record<string, string> = {}
): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-compat-'))
  roots.push(root)
  writeFileSync(join(root, PACKAGE_JSON), JSON.stringify({ name: 'app', dependencies }))
  for (const [name, version] of Object.entries(versions)) install(root, name, version)
  return root
}

const MATCHING = {
  '@sveltejs/kit': '2.70.3',
  svelte: '5.57.1',
  vite: '8.3.1',
  typescript: '6.0.3',
  '@project-vault/composition-kit': '0.1.0',
}

describe('resolveInstalledVersion', () => {
  it('reads the installed version, walking up node_modules, never a declared range', () => {
    const root = makeApp({ vite: '8.3.1' })
    const nested = join(root, 'apps', 'pv-composed')
    mkdirSync(nested, { recursive: true })
    expect(resolveInstalledVersion(nested, 'vite')).toBe('8.3.1')
    expect(resolveInstalledVersion(nested, 'nope')).toBeUndefined()
    expect(dirname(nested)).toBeTruthy()
  })
})

describe('validateTuple', () => {
  it('accepts a complete tuple and names every missing or null field', () => {
    expect(validateTuple(TUPLE)).toEqual({ tuple: TUPLE, problems: [] })
    const broken = validateTuple({ ...TUPLE, kitVersion: null, toolchain: { kit: '2.70.3' } })
    expect(broken.problems).toEqual([
      expect.stringContaining('kitVersion'),
      expect.stringContaining('toolchain.svelte'),
      expect.stringContaining('toolchain.typescript'),
      expect.stringContaining('toolchain.vite'),
    ])
    expect(validateTuple('x').problems).toEqual([expect.stringContaining('object')])
  })
})

describe('checkCompatibility (design section 11, AC-10)', () => {
  const modulePackOk = (): string => makeApp({ '@project-vault/extension-api': '3.25.0' })

  it('passes when every resolved version equals the tuple', () => {
    const result = checkCompatibility({
      appRoot: makeApp(MATCHING),
      appLabel: 'apps/pv-composed',
      tuple: TUPLE,
      packPvRelease: '1.5.0',
      modulePack: modulePackOk(),
    })
    expect(result).toEqual({ problems: [], notes: [] })
  })

  it('CM today: four mismatches in one run, not one at a time', () => {
    const result = checkCompatibility({
      appRoot: makeApp({
        ...MATCHING,
        '@sveltejs/kit': '2.70.2',
        svelte: '5.56.8',
        vite: '7.3.6',
        typescript: '5.9.3',
      }),
      appLabel: 'apps/pv-composed',
      tuple: TUPLE,
      packPvRelease: '1.5.0',
    })
    expect(result.problems).toEqual([
      'Compatibility mismatch: @sveltejs/kit resolved 2.70.2 (apps/pv-composed), web-host was built with 2.70.3.',
      'Compatibility mismatch: svelte resolved 5.56.8 (apps/pv-composed), web-host was built with 5.57.1.',
      'Compatibility mismatch: vite resolved 7.3.6 (apps/pv-composed), web-host was built with 8.3.1.',
      'Compatibility mismatch: typescript resolved 5.9.3 (apps/pv-composed), web-host was built with 6.0.3.',
    ])
    expect(result.notes).toEqual([expect.stringContaining('extension-api version not checked')])
  })

  it('fails a kit mismatch, a missing package and a prerelease compared as an exact string', () => {
    const result = checkCompatibility({
      appRoot: makeApp({
        ...MATCHING,
        '@project-vault/composition-kit': '0.1.1',
        vite: '8.3.1-rc.0',
      }),
      appLabel: 'app',
      tuple: TUPLE,
      packPvRelease: '1.5.0',
    })
    expect(result.problems).toEqual([
      'Compatibility mismatch: vite resolved 8.3.1-rc.0 (app), web-host was built with 8.3.1.',
      'Compatibility mismatch: @project-vault/composition-kit resolved 0.1.1 (app), web-host was built with 0.1.0.',
    ])
    const noVite = makeApp({
      '@sveltejs/kit': '2.70.3',
      svelte: '5.57.1',
      typescript: '6.0.3',
      '@project-vault/composition-kit': '0.1.0',
    })
    expect(
      checkCompatibility({ appRoot: noVite, appLabel: 'app', tuple: TUPLE, packPvRelease: '1.5.0' })
        .problems
    ).toEqual([expect.stringContaining('vite is not installed')])
  })

  it('fails a manifest that targets another PV release', () => {
    const result = checkCompatibility({
      appRoot: makeApp(MATCHING),
      appLabel: 'app',
      tuple: TUPLE,
      packPvRelease: '1.4.0',
    })
    expect(result.problems).toEqual([
      'Compatibility mismatch: manifest targets PV 1.4.0 but web-host is 1.5.0; run the upgrade flow.',
    ])
  })

  it('compares the module pack extension-api, or notes that it was not checked', () => {
    const wrong = makeApp({ '@project-vault/extension-api': '3.23.0' })
    const result = checkCompatibility({
      appRoot: makeApp(MATCHING),
      appLabel: 'app',
      tuple: TUPLE,
      packPvRelease: '1.5.0',
      modulePack: wrong,
    })
    expect(result.problems).toEqual([
      `Compatibility mismatch: @project-vault/extension-api resolved 3.23.0 (module pack ${wrong}), web-host was built with 3.25.0.`,
    ])
  })
})

describe('checkRuntimeDependencies (AC-10)', () => {
  const hostDependencies = { undici: '7.29.1', dompurify: '3.4.16' }

  it('passes when every web-host dependency is a runtime dependency at the identical version', () => {
    const root = makeApp(
      { undici: '7.29.1', dompurify: '3.4.16' },
      { undici: '7.29.1', dompurify: '3.4.16' }
    )
    expect(checkRuntimeDependencies(root, hostDependencies)).toEqual([])
  })

  it('lists every offender, sorted: missing, dev-only, and different version', () => {
    const root = makeApp(
      { undici: '7.0.0', dompurify: '3.4.16', semver: '7.8.5' },
      { undici: '7.29.1' }
    )
    writeFileSync(
      join(root, PACKAGE_JSON),
      JSON.stringify({
        dependencies: { undici: '7.29.1' },
        devDependencies: { dompurify: '3.4.16' },
      })
    )
    expect(checkRuntimeDependencies(root, { ...hostDependencies, semver: '7.8.5' })).toEqual([
      'Runtime dependency dompurify must be a runtime dependency of the composed app (adapter-node externalizes only dependencies).',
      'Runtime dependency semver must be a runtime dependency of the composed app (adapter-node externalizes only dependencies).',
      'Runtime dependency undici resolved 7.0.0, web-host requires 7.29.1.',
    ])
  })
})
