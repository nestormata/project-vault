import { describe, expect, it } from 'vitest'
import { getReleaseVersion, DEV_RELEASE_VERSION } from './package-version.js'

// Story 9.10 AC-1/AC-6: getReleaseVersion() is the sole release-identity source of truth —
// never reads package.json (which stays a permanent 0.0.1 workspace-tooling placeholder).
describe('getReleaseVersion', () => {
  it('AC-1: reports the RELEASE_VERSION env value as a release when set', () => {
    const result = getReleaseVersion({ RELEASE_VERSION: '1.0.2' })

    expect(result).toEqual({ version: '1.0.2', isRelease: true })
  })

  it('AC-1: falls back to the documented dev literal when RELEASE_VERSION is unset', () => {
    const result = getReleaseVersion({})

    expect(result).toEqual({ version: DEV_RELEASE_VERSION, isRelease: false })
  })

  it('never returns the workspace-placeholder 0.0.1 value, even if package.json is 0.0.1', () => {
    const result = getReleaseVersion({})

    expect(result.version).not.toBe('0.0.1')
  })

  it('AC-1: treats a blank/whitespace-only RELEASE_VERSION as unset, not a silent fake release', () => {
    const result = getReleaseVersion({ RELEASE_VERSION: '   ' })

    expect(result).toEqual({ version: DEV_RELEASE_VERSION, isRelease: false })
  })

  it("AC-1: treats an explicit RELEASE_VERSION='dev' as the dev fallback, not a release", () => {
    // The Dockerfiles default `ARG RELEASE_VERSION=dev`, so this literal reaches the runtime
    // whenever a build did not pass the build-arg — reporting it as a release build would be the
    // exact misrepresentation AC-1 forbids.
    const result = getReleaseVersion({ RELEASE_VERSION: DEV_RELEASE_VERSION })

    expect(result).toEqual({ version: DEV_RELEASE_VERSION, isRelease: false })
  })

  it.each(['DEV', 'Dev', ' dEv '])(
    "AC-1: treats RELEASE_VERSION='%s' as the dev fallback too — the guard is case-insensitive",
    (raw) => {
      const result = getReleaseVersion({ RELEASE_VERSION: raw })

      expect(result).toEqual({ version: DEV_RELEASE_VERSION, isRelease: false })
    }
  )

  it('trims incidental surrounding whitespace from a real release value', () => {
    const result = getReleaseVersion({ RELEASE_VERSION: '  1.2.3  ' })

    expect(result).toEqual({ version: '1.2.3', isRelease: true })
  })

  it('defaults to reading from process.env when no override is given', () => {
    const original = process.env.RELEASE_VERSION
    process.env.RELEASE_VERSION = '2.5.0'
    try {
      expect(getReleaseVersion()).toEqual({ version: '2.5.0', isRelease: true })
    } finally {
      if (original === undefined) delete process.env.RELEASE_VERSION
      else process.env.RELEASE_VERSION = original
    }
  })
})
