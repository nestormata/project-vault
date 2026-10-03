import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Story 68.3 AC-1: the publishable MIT package shape (ADR 0007 decision 9), the same flow as
// @project-vault/extension-api: OIDC provenance, public, no install-time code, no workspace links.

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')
) as Record<string, unknown>

describe('package.json (Story 68.3 AC-1)', () => {
  it('is MIT, ESM, public and provenance-published', () => {
    expect(manifest).toMatchObject({
      name: '@project-vault/composition-kit',
      version: '0.6.0',
      license: 'MIT',
      type: 'module',
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org/',
        provenance: true,
      },
      engines: { node: '>=20' },
      repository: { directory: 'packages/composition-kit' },
    })
    expect('private' in manifest).toBe(false)
  })

  it('exposes the pv-compose bin, the library entry and the Vite plugin entry', () => {
    expect(manifest.bin).toEqual({
      'pv-compose': './dist/cli.js',
      'pv-verify': './dist/verify-cli.js',
    })
    const exportedEntries = Object.keys(manifest.exports as object).sort()
    expect(exportedEntries).toEqual(['.', './nav', './package.json', './pv-original', './vite'])
  })

  it('ships only dist, the pv-original typings, LICENSE, README.md and CHANGELOG.md', () => {
    expect(manifest.files).toEqual([
      'dist',
      'pv-original.d.ts',
      'LICENSE',
      'README.md',
      'CHANGELOG.md',
    ])
  })

  it('runs no code on install and depends on no workspace package or web-host', () => {
    const scripts = Object.keys((manifest.scripts ?? {}) as object)
    expect(scripts.filter((name) => /^(pre|post)?install$|^prepare$/.test(name))).toEqual([])
    expect(manifest.dependencies).toBeUndefined()
    const all = JSON.stringify({ d: manifest.dependencies, p: manifest.peerDependencies })
    expect(all).not.toContain('workspace:')
    expect(all).not.toContain('@project-vault/')
  })

  it('takes its parsers from the app as peer dependencies (Vite only for the dev plugin)', () => {
    expect(Object.keys(manifest.peerDependencies as object).sort()).toEqual([
      'svelte',
      'typescript',
      'vite',
    ])
    expect(manifest.peerDependenciesMeta).toEqual({ vite: { optional: true } })
  })
})
