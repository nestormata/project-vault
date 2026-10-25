import { describe, expect, it } from 'vitest'
import type { ApiClientError } from '$lib/api/client.js'
import { apiClientError } from '$lib/test/api-error.js'
import { sampleCredential, sampleProject } from '$lib/test/fixtures.js'
import {
  ARCHIVED_PROJECT_BANNER,
  CREDENTIAL_ARCHIVED_BANNER,
  archivedBannerFor,
  canArchiveCredential,
  canRevealCredential,
  credentialKeyOf,
  credentialPointExtras,
  fieldMetaOf,
  isCredentialArchived,
  isMultiFieldCredential,
} from './credential-detail-helpers.js'

// Story 69.2 Task 1: the pure derivations the extracted regions of the credential detail page share.

function apiError(status: number, code: string): ApiClientError {
  return apiClientError(status, { error: code }, code)
}

describe('credentialKeyOf', () => {
  it('is one primitive per record and differs across records', () => {
    expect(credentialKeyOf('p1', 'c1')).toBe('p1/c1')
    expect(credentialKeyOf('p1', 'c1')).not.toBe(credentialKeyOf('p1', 'c2'))
    expect(credentialKeyOf('p1', 'c1')).not.toBe(credentialKeyOf('p2', 'c1'))
  })
})

describe('archivedBannerFor', () => {
  it('maps a credential_archived 410 to the secret copy', () => {
    expect(archivedBannerFor(apiError(410, 'credential_archived'))).toBe(CREDENTIAL_ARCHIVED_BANNER)
  })
  it('maps any other 410 to the project copy', () => {
    expect(archivedBannerFor(apiError(410, 'project_archived'))).toBe(ARCHIVED_PROJECT_BANNER)
  })
  it('is null for a non-410 or a non-API error', () => {
    expect(archivedBannerFor(apiError(409, 'credential_archived'))).toBeNull()
    expect(archivedBannerFor(new Error('x'))).toBeNull()
    expect(archivedBannerFor(undefined)).toBeNull()
  })
})

describe('role derivations', () => {
  const project = (role: 'owner' | 'member' | 'viewer') => sampleProject({ role })
  it('canRevealCredential needs a creator org role, a project and a non-viewer project role', () => {
    expect(canRevealCredential('member', project('member'))).toBe(true)
    expect(canRevealCredential('owner', project('owner'))).toBe(true)
    expect(canRevealCredential('member', project('viewer'))).toBe(false)
    expect(canRevealCredential('viewer', project('member'))).toBe(false)
    expect(canRevealCredential('member', null)).toBe(false)
  })
  it('canArchiveCredential is project-owner-or-org-owner and needs a project', () => {
    expect(canArchiveCredential('member', project('owner'))).toBe(true)
    expect(canArchiveCredential('owner', project('member'))).toBe(true)
    expect(canArchiveCredential('admin', project('member'))).toBe(false)
    expect(canArchiveCredential('owner', null)).toBe(false)
  })
})

describe('credential shape derivations', () => {
  it('isCredentialArchived reads archivedAt and tolerates null', () => {
    expect(isCredentialArchived(sampleCredential({ archivedAt: '2026-01-01T00:00:00.000Z' }))).toBe(
      true
    )
    expect(isCredentialArchived(sampleCredential())).toBe(false)
    expect(isCredentialArchived(null)).toBe(false)
  })
  it('fieldMetaOf falls back to the one implicit sensitive default field', () => {
    expect(fieldMetaOf(null)).toEqual([{ key: 'value', sensitive: true }])
    expect(fieldMetaOf(sampleCredential({ fields: [{ key: 'a', sensitive: false }] }))).toEqual([
      { key: 'a', sensitive: false },
    ])
  })
  it('isMultiFieldCredential is false only for the default single field', () => {
    expect(isMultiFieldCredential(fieldMetaOf(null))).toBe(false)
    expect(isMultiFieldCredential([{ key: 'a', sensitive: true }])).toBe(true)
    expect(
      isMultiFieldCredential([
        { key: 'value', sensitive: true },
        { key: 'b', sensitive: false },
      ])
    ).toBe(true)
  })
})

describe('credentialPointExtras', () => {
  const base = {
    projectId: 'p1',
    credentialId: 'c1',
    orgRole: 'member' as const,
    credential: sampleCredential(),
  }
  it('carries credential, project, ids and both roles', () => {
    const project = sampleProject({ role: 'viewer' })
    expect(credentialPointExtras({ ...base, project })).toEqual({
      credential: base.credential,
      project,
      projectId: 'p1',
      credentialId: 'c1',
      orgRole: 'member',
      projectRole: 'viewer',
    })
  })
  it('has a null projectRole (and no throw) without a project, and a null credential', () => {
    expect(credentialPointExtras({ ...base, project: null, credential: null })).toMatchObject({
      credential: null,
      project: null,
      projectRole: null,
      orgRole: 'member',
    })
  })
  it('never carries anything beyond the contract', () => {
    expect(Object.keys(credentialPointExtras({ ...base, project: null })).sort()).toEqual([
      'credential',
      'credentialId',
      'orgRole',
      'project',
      'projectId',
      'projectRole',
    ])
  })
})
