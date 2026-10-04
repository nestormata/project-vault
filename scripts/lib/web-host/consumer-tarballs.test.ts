// Story 68.10 AC-2.1: the pack-and-compose steps the composition kit integration test used to inline
// are shared (scripts/lib/web-host/consumer-tarballs.ts), so the mechanism e2e job reuses them
// instead of copying a second harness. The packing itself is exercised by the integration job; here
// the pure parts.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { consumerFixtureEnv, installedVersion, kitFixturesDir } from './consumer-tarballs.js'

const WORK = '/w'
const KIT_TGZ = '/w/kit.tgz'

describe('consumerFixtureEnv', () => {
  const tarballs = {
    webHostTarball: '/w/web-host.tgz',
    kitTarball: KIT_TGZ,
    extensionApiTarball: '/w/ext.tgz',
  }

  it('hands the consumer the kit tarball, a private npm cache and the pinned tool versions', () => {
    const env = consumerFixtureEnv({ KEEP: '1' }, WORK, tarballs)
    expect(env.KEEP).toBe('1')
    expect(env.WEB_HOST_FIXTURE_CACHE).toBe(join(WORK, 'npm-cache'))
    expect(env.COMPOSITION_KIT_TARBALL).toBe(KIT_TGZ)
    expect(env.COMPOSITION_KIT_FIXTURES).toBe(kitFixturesDir())
    expect(env.WEB_HOST_FIXTURE_EXTENSION_API_TARBALL).toBe('/w/ext.tgz')
    expect(env.COMPOSITION_KIT_SVELTE_CHECK).toBe(installedVersion('svelte-check'))
    expect(env.COMPOSITION_KIT_TYPES_NODE).toBe(installedVersion('@types/node'))
  })

  it('leaves the extension-api tarball unset when it comes from the registry', () => {
    const env = consumerFixtureEnv({}, WORK, { ...tarballs, extensionApiTarball: undefined })
    expect('WEB_HOST_FIXTURE_EXTENSION_API_TARBALL' in env).toBe(false)
  })

  it('lets the caller override the fixtures directory (the mock pack job points it at its own)', () => {
    const env = consumerFixtureEnv({}, WORK, tarballs, { fixturesDir: '/pack/fixtures' })
    expect(env.COMPOSITION_KIT_FIXTURES).toBe('/pack/fixtures')
  })

  it('does not let the parent environment override the pinned values', () => {
    const env = consumerFixtureEnv({ COMPOSITION_KIT_TARBALL: '/evil.tgz' }, WORK, tarballs)
    expect(env.COMPOSITION_KIT_TARBALL).toBe(KIT_TGZ)
  })

  it('reads a version from apps/web and throws for an unknown package', () => {
    expect(installedVersion('svelte')).toMatch(/^\d+\.\d+\.\d+/)
    expect(() => installedVersion('definitely-not-installed-pkg')).toThrow()
  })
})
