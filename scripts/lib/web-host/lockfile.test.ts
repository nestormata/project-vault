import { describe, expect, it } from 'vitest'
import {
  isExactVersion,
  findDrift,
  importerDependencies,
  parseLockfile,
  singleVersion,
  stripPeerSuffix,
} from './lockfile.js'

// Story 68.2 AC-2: versions come from pnpm-lock.yaml, and drift between package.json and the
// lockfile fails the pack.

const LOCKFILE = `lockfileVersion: '9.0'
importers:
  apps/web:
    dependencies:
      '@project-vault/extension-api':
        specifier: workspace:*
        version: link:../../packages/extension-api
      dompurify:
        specifier: 3.4.16
        version: 3.4.16
    devDependencies:
      svelte:
        specifier: ^5.57.1
        version: 5.57.1(@typescript-eslint/types@8.70.1)
      vite:
        specifier: ^8.3.1
        version: 8.3.1(@types/node@26.6.2)(esbuild@0.27.7)
`

describe('pnpm-lock.yaml reader', () => {
  const locked = importerDependencies(parseLockfile(LOCKFILE), 'apps/web')

  it('strips the peer suffix from a resolved version', () => {
    expect(stripPeerSuffix('8.3.1(@types/node@26.6.2)(esbuild@0.27.7)')).toBe('8.3.1')
    expect(stripPeerSuffix('3.4.16')).toBe('3.4.16')
  })

  it('reads every direct dependency of an importer with its exact version', () => {
    expect(locked.get('svelte')).toEqual({ specifier: '^5.57.1', version: '5.57.1' })
    expect(locked.get('vite')?.version).toBe('8.3.1')
    expect(locked.get('@project-vault/extension-api')).toMatchObject({
      link: '../../packages/extension-api',
    })
  })

  it('fails on an unknown importer and on a lockfile with no importers', () => {
    expect(() => importerDependencies(parseLockfile(LOCKFILE), 'apps/nope')).toThrow(/apps\/nope/)
    expect(() => parseLockfile("lockfileVersion: '9.0'\n")).toThrow(/importers/)
  })

  it('reports no drift when every declared range matches the lockfile', () => {
    expect(
      findDrift(
        { svelte: '^5.57.1', vite: '^8.3.1', '@project-vault/extension-api': 'workspace:*' },
        locked
      )
    ).toEqual([])
  })

  it('AC-2 failure example 1: a range bumped without regenerating the lockfile', () => {
    expect(findDrift({ svelte: '^5.60.0' }, locked)).toEqual([
      'drift: svelte declared ^5.60.0, lockfile 5.57.1',
    ])
  })

  it('reports a declared dependency missing from the lockfile', () => {
    expect(findDrift({ 'left-pad': '1.3.0' }, locked)).toEqual([
      'drift: left-pad declared 1.3.0, missing from the lockfile',
    ])
  })

  it('fails when two importers resolved different base versions for one package', () => {
    expect(singleVersion('zod', ['4.6.5', '4.6.5'])).toBe('4.6.5')
    expect(() => singleVersion('zod', ['4.6.5', '4.7.0'])).toThrow(
      /zod resolves to several versions/
    )
    expect(() => singleVersion('zod', [])).toThrow(/no lockfile version/)
  })

  it('accepts exact and prerelease versions only', () => {
    for (const version of ['1.4.0', '1.4.0-rc.1', '0.0.0-dev'])
      expect(isExactVersion(version)).toBe(true)
    for (const version of [
      '^1.4.0',
      '~1.4.0',
      'workspace:*',
      '1.4',
      '*',
      'v1.4.0',
      '1.4.0+build.1',
    ]) {
      expect(isExactVersion(version), version).toBe(false)
    }
  })
})
