import { describe, expect, it } from 'vitest'
import {
  OPTIONAL_MANIFESTS,
  buildCompatibilityManifest,
  buildPackageJson,
  optionalManifestsToPack,
  packageJsonProblems,
  packageJsonShape,
} from './package-manifest.js'

// Story 68.2 AC-2/AC-6/AC-9: the generated package.json and compatibility manifest.

const INPUT = {
  version: '1.4.0',
  repositoryUrl: 'git+https://github.com/nestormata/project-vault.git',
  nodeEngine: '>=24.0.0',
  dependencies: { zod: '4.6.5', dompurify: '3.4.16' },
  peerDependencies: { svelte: '5.57.1', jsdom: '30.1.1', vite: '8.3.1' },
}

describe('generated package.json (Story 68.2 AC-6)', () => {
  const pkg = buildPackageJson(INPUT)

  it('is publishable: AGPL, public, provenance, module, no private/scripts/devDependencies', () => {
    expect(pkg).toMatchObject({
      name: '@project-vault/web-host',
      version: '1.4.0',
      license: 'AGPL-3.0-or-later',
      type: 'module',
      engines: { node: '>=24.0.0' },
      publishConfig: { access: 'public', provenance: true },
      webHost: { sharedSource: 'vendor/shared/src' },
    })
    expect(packageJsonProblems(pkg)).toEqual([])
  })

  it('marks the peers only the shipped unit tests need as optional', () => {
    const withTestPeers = buildPackageJson({
      ...INPUT,
      peerDependencies: { ...INPUT.peerDependencies, '@testing-library/svelte': '5.4.2' },
      optionalPeers: ['@testing-library/svelte'],
    })
    expect(withTestPeers.peerDependenciesMeta).toEqual({
      '@testing-library/svelte': { optional: true },
      jsdom: { optional: true },
    })
  })

  it('sorts dependencies and marks only the test-time peers optional', () => {
    expect(Object.keys(pkg.dependencies as object)).toEqual(['dompurify', 'zod'])
    expect(pkg.peerDependenciesMeta).toEqual({ jsdom: { optional: true } })
  })

  it('exports every shipped directory and the config factories, never a curated subset', () => {
    const exports = pkg.exports as Record<string, unknown>
    for (const key of [
      './src/*',
      './static/*',
      './messages/*',
      './project.inlang/*',
      './vendor/*',
      './manifest',
      './package.json',
    ]) {
      expect(exports, key).toHaveProperty([key])
    }
    expect(exports['./vite.config']).toEqual({
      types: './config/vite.config.d.ts',
      default: './config/vite.config.js',
    })
  })

  it('reports every forbidden key and every non-exact specifier', () => {
    const problems = packageJsonProblems({
      ...pkg,
      private: true,
      scripts: { postinstall: 'x' },
      bin: 'x',
      dependencies: { a: '^1.0.0', b: 'workspace:*', c: '1.0.0' },
    })
    expect(problems).toEqual([
      'must not contain "private"',
      'must not contain "scripts"',
      'must not contain "bin"',
      'dependencies.a is ^1.0.0, not an exact version',
      'dependencies.b is workspace:*, not an exact version',
    ])
  })

  it('reduces to a version-free shape for the golden comparison', () => {
    const shape = packageJsonShape(pkg)
    expect(shape.version).toBe('<pv-release>')
    expect(shape.dependencies).toEqual({ dompurify: '<exact>', zod: '<exact>' })
  })
})

describe('compatibility manifest (Story 68.2 AC-9)', () => {
  const text = buildCompatibilityManifest({
    pvRelease: '1.4.0-rc.1',
    extensionApiVersion: '3.25.0',
    toolchain: { kit: '2.70.3', svelte: '5.57.1', vite: '8.3.1', typescript: '6.0.3' },
    apiImageTag: 'ghcr.io/nestormata/project-vault/api:1.4.0-rc.1',
  })

  it('has sorted keys, a trailing newline and kitVersion null', () => {
    expect(text.endsWith('}\n')).toBe(true)
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual([
      'apiImageTag',
      'extensionApiVersion',
      'kitVersion',
      'pvRelease',
      'schemaVersion',
      'toolchain',
    ])
    expect(Object.keys(parsed.toolchain as object)).toEqual(['kit', 'svelte', 'typescript', 'vite'])
    expect(parsed.kitVersion).toBeNull()
    expect(parsed.schemaVersion).toBe(1)
  })
})

describe('later generated manifests (Story 68.2 AC-9)', () => {
  it('packs exactly the ones that exist and never stubs a missing one', () => {
    expect(optionalManifestsToPack(new Set())).toEqual([])
    expect(optionalManifestsToPack(new Set(['nav-ids.json', 'unrelated.json']))).toEqual([
      'nav-ids.json',
    ])
    expect(optionalManifestsToPack(new Set(OPTIONAL_MANIFESTS))).toEqual([...OPTIONAL_MANIFESTS])
  })
})
