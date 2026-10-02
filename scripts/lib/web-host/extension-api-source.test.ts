import { describe, expect, it } from 'vitest'
import { extensionApiFallbackLine, extensionApiSource } from './extension-api-source.js'

// Story 68.2 code review (Nestor 2026-10-02, option a): the consumer fixture installs
// @project-vault/extension-api from npm when PV's exact version is published, and from a tarball
// packed from the workspace only when npm answers E404 and the run is not registry-only. The release
// workflow is registry-only, so a release can never ship against an unpublished extension-api.

const VERSION = '3.26.0'
const E404 = {
  status: 1,
  stdout: '',
  stderr: 'npm error code E404\nnpm error 404 No match found for version 3.26.0',
}
const PUBLISHED = { status: 0, stdout: '3.26.0\n', stderr: '' }

describe('extensionApiSource (Story 68.2 AC-8, Nestor 2026-10-02)', () => {
  it('uses the registry when the exact version is published', () => {
    expect(extensionApiSource(VERSION, PUBLISHED, { registryOnly: false })).toEqual({
      kind: 'registry',
    })
    expect(extensionApiSource(VERSION, PUBLISHED, { registryOnly: true })).toEqual({
      kind: 'registry',
    })
  })

  it('falls back to a workspace tarball on E404 outside a registry-only run', () => {
    expect(extensionApiSource(VERSION, E404, { registryOnly: false })).toEqual({
      kind: 'workspace',
      reason: 'npm view answered E404',
    })
  })

  it('fails on E404 in a registry-only run (the release), naming the version and the flag', () => {
    expect(() => extensionApiSource(VERSION, E404, { registryOnly: true })).toThrow(
      /extension-api@3\.26\.0 is not on npm.*WEB_HOST_FIXTURE_REGISTRY_ONLY=1/
    )
  })

  it('fails on any other npm view failure (network, auth), never falling back', () => {
    const network = { status: 1, stdout: '', stderr: 'npm error code ENOTFOUND\nnpm error network' }
    for (const registryOnly of [false, true]) {
      expect(() => extensionApiSource(VERSION, network, { registryOnly })).toThrow(
        /could not confirm.*ENOTFOUND/s
      )
    }
    const killed = { status: null, stdout: '', stderr: '' }
    expect(() => extensionApiSource(VERSION, killed, { registryOnly: false })).toThrow(
      /could not confirm/
    )
  })

  it('fails when npm view succeeds but names another version or nothing', () => {
    for (const stdout of ['', '3.25.0\n']) {
      expect(() =>
        extensionApiSource(VERSION, { status: 0, stdout, stderr: '' }, { registryOnly: false })
      ).toThrow(/could not confirm/)
    }
  })

  it('logs one line naming the version, the reason and that the release stays strict', () => {
    expect(extensionApiFallbackLine(VERSION, 'npm view answered E404')).toBe(
      'fixture: @project-vault/extension-api@3.26.0 is not on npm yet (npm view answered E404), so ' +
        'the consumer installs a tarball packed from packages/extension-api instead. PR and local ' +
        'runs only: the release sets WEB_HOST_FIXTURE_REGISTRY_ONLY=1 and requires the registry version.'
    )
  })
})
