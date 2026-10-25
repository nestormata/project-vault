import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureRouteContext } from '../../lib/secure-route.js'
import type { OrgRole } from '../../plugins/require-org-role.js'

vi.mock('./member-management.js', () => ({
  getProjectMembershipRole: vi.fn(),
}))

import { getProjectMembershipRole } from './member-management.js'
import {
  callerCanSeeProject,
  effectiveProjectRole,
  effectiveProjectRoleForCaller,
} from './project-access.js'

const getProjectMembershipRoleMock = vi.mocked(getProjectMembershipRole)
const PROJECT_UUID = randomUUID()

function makeSecureCtx(orgRole: OrgRole, overrides: Partial<SecureRouteContext['auth']> = {}) {
  return {
    auth: {
      userId: 'user-1',
      orgId: 'org-1',
      orgRole,
      ...overrides,
    },
    tx: {} as SecureRouteContext['tx'],
    audit: {},
  } as SecureRouteContext
}

describe('callerCanSeeProject (AC-V1)', () => {
  beforeEach(() => {
    getProjectMembershipRoleMock.mockReset()
  })

  it('returns true for org admin with no membership row and never queries', async () => {
    const secureCtx = makeSecureCtx('admin')
    await expect(callerCanSeeProject(secureCtx, 'project-1')).resolves.toBe(true)
    expect(getProjectMembershipRoleMock).not.toHaveBeenCalled()
  })

  it('returns true for org owner with no membership row and never queries', async () => {
    const secureCtx = makeSecureCtx('owner')
    await expect(callerCanSeeProject(secureCtx, 'project-1')).resolves.toBe(true)
    expect(getProjectMembershipRoleMock).not.toHaveBeenCalled()
  })

  it('returns true for org member when a project membership row exists', async () => {
    getProjectMembershipRoleMock.mockResolvedValue('viewer')
    const secureCtx = makeSecureCtx('member')
    await expect(callerCanSeeProject(secureCtx, 'project-1')).resolves.toBe(true)
    expect(getProjectMembershipRoleMock).toHaveBeenCalledWith(secureCtx.tx, {
      orgId: 'org-1',
      projectId: 'project-1',
      userId: 'user-1',
    })
  })

  it('returns false for org member when no project membership row exists', async () => {
    getProjectMembershipRoleMock.mockResolvedValue(undefined)
    const secureCtx = makeSecureCtx('member')
    await expect(callerCanSeeProject(secureCtx, 'project-1')).resolves.toBe(false)
  })
})

describe('effectiveProjectRole (AC-P1)', () => {
  beforeEach(() => {
    getProjectMembershipRoleMock.mockReset()
  })

  it('returns project role viewer for an org member with an explicit viewer grant', async () => {
    getProjectMembershipRoleMock.mockResolvedValue('viewer')
    const secureCtx = makeSecureCtx('member')
    await expect(effectiveProjectRole(secureCtx, PROJECT_UUID)).resolves.toBe('viewer')
  })

  it('returns project role admin for an org member elevated within one project', async () => {
    getProjectMembershipRoleMock.mockResolvedValue('admin')
    const secureCtx = makeSecureCtx('member')
    await expect(effectiveProjectRole(secureCtx, PROJECT_UUID)).resolves.toBe('admin')
  })

  it('short-circuits to org owner with no query when no project row exists', async () => {
    const secureCtx = makeSecureCtx('owner')
    await expect(effectiveProjectRole(secureCtx, PROJECT_UUID)).resolves.toBe('owner')
    expect(getProjectMembershipRoleMock).not.toHaveBeenCalled()
  })

  it('falls back to org role when member has no project membership row (AC-P5 defensive path)', async () => {
    getProjectMembershipRoleMock.mockResolvedValue(undefined)
    const secureCtx = makeSecureCtx('member')
    await expect(effectiveProjectRole(secureCtx, PROJECT_UUID)).resolves.toBe('member')
  })
})

describe('effectiveProjectRoleForCaller (Story 69.17)', () => {
  beforeEach(() => {
    getProjectMembershipRoleMock.mockReset()
  })

  it('reads the membership row with the given transaction and caller', async () => {
    getProjectMembershipRoleMock.mockResolvedValue('viewer')
    const secureCtx = makeSecureCtx('member')
    await expect(
      effectiveProjectRoleForCaller(secureCtx.tx, secureCtx.auth, PROJECT_UUID)
    ).resolves.toBe('viewer')
    expect(getProjectMembershipRoleMock).toHaveBeenCalledWith(secureCtx.tx, {
      orgId: 'org-1',
      projectId: PROJECT_UUID,
      userId: 'user-1',
    })
  })

  it('keeps the org admin bypass even over an explicit viewer row (never queried)', async () => {
    getProjectMembershipRoleMock.mockResolvedValue('viewer')
    const secureCtx = makeSecureCtx('admin')
    await expect(
      effectiveProjectRoleForCaller(secureCtx.tx, secureCtx.auth, PROJECT_UUID)
    ).resolves.toBe('admin')
    expect(getProjectMembershipRoleMock).not.toHaveBeenCalled()
  })

  it('a non-UUID project id never queries and resolves to the org role', async () => {
    const secureCtx = makeSecureCtx('viewer')
    await expect(
      effectiveProjectRoleForCaller(secureCtx.tx, secureCtx.auth, 'not-a-uuid')
    ).resolves.toBe('viewer')
    expect(getProjectMembershipRoleMock).not.toHaveBeenCalled()
  })

  it('denies a caller with no org role (fails closed)', async () => {
    const secureCtx = makeSecureCtx('member', { orgRole: undefined })
    await expect(
      effectiveProjectRoleForCaller(secureCtx.tx, secureCtx.auth, PROJECT_UUID)
    ).rejects.toMatchObject({ code: 'insufficient_role' })
  })
})
