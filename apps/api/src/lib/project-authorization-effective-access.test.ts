import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveActiveOrgRole } = vi.hoisted(() => ({
  resolveActiveOrgRole: vi.fn(),
}))
vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRole }))

const { withOrg } = vi.hoisted(() => ({
  withOrg: vi.fn(),
}))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

import { checkProjectAuthorization } from './project-authorization.js'
import {
  readEffectiveProjectAccess,
  __getEffectiveProjectAccessInFlightCountForTests,
  __resetEffectiveProjectAccessRateLimitForTests,
} from './project-authorization-effective-access.js'
import { __resetProjectAuthorizationRateLimitForTests } from './project-authorization.js'
import { runWithRequestContext } from './request-context.js'

const ORG_ID = 'org-1'
const CALLER_ID = 'caller-1'
const VIEWER_ID = randomUUID()
const TEST_EXTENSION_NAME = 'test-extension-access-read'

function withAmbientOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ orgId: ORG_ID, userId: CALLER_ID }, fn)
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetEffectiveProjectAccessRateLimitForTests()
  __resetProjectAuthorizationRateLimitForTests()
  withOrg.mockImplementation(async () => [])
})

describe('readEffectiveProjectAccess (Story 73.6 host)', () => {
  it('returns error no-request-context without ambient org', async () => {
    const result = await readEffectiveProjectAccess({ viewerIdentityId: VIEWER_ID })
    expect(result).toEqual({ outcome: 'error', reasonCode: 'no-request-context' })
  })

  it('returns error invalid-context for a non-object argument', async () => {
    const result = await withAmbientOrg(() =>
      readEffectiveProjectAccess(null as unknown as { viewerIdentityId: string })
    )
    expect(result).toEqual({ outcome: 'error', reasonCode: 'invalid-context' })
  })

  it('returns empty ok for a non-uuid viewer without enumerating', async () => {
    const result = await withAmbientOrg(() =>
      readEffectiveProjectAccess({ viewerIdentityId: 'not-a-uuid' })
    )
    expect(result).toEqual({
      outcome: 'ok',
      items: [],
      groupGrantEvaluation: 'not_evaluated',
    })
    expect(withOrg).not.toHaveBeenCalled()
  })

  it('rate-limits on its own in-flight cap and releases the slot', async () => {
    let releaseFirst: (() => void) | undefined
    withOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([])
        })
    )
    const hostContext = { extensionName: TEST_EXTENSION_NAME, maxInFlight: 1 }
    const firstPromise = withAmbientOrg(() =>
      readEffectiveProjectAccess({ viewerIdentityId: VIEWER_ID }, hostContext)
    )
    await Promise.resolve()
    await Promise.resolve()
    const second = await withAmbientOrg(() =>
      readEffectiveProjectAccess({ viewerIdentityId: VIEWER_ID }, hostContext)
    )
    expect(second).toEqual({ outcome: 'error', reasonCode: 'rate-limited' })
    expect(__getEffectiveProjectAccessInFlightCountForTests(TEST_EXTENSION_NAME)).toBe(1)
    releaseFirst?.()
    await firstPromise
    expect(__getEffectiveProjectAccessInFlightCountForTests(TEST_EXTENSION_NAME)).toBe(0)
  })

  it('does not share checkProjectMembership in-flight budget', async () => {
    let releaseCheck: (() => void) | undefined
    withOrg.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve([{ role: null }])
        })
    )
    resolveActiveOrgRole.mockResolvedValue('owner')
    const sharedName = 'shared-extension-name'
    const hanging = withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: VIEWER_ID, minimumRole: 'viewer' },
        { extensionName: sharedName, maxInFlight: 1 }
      )
    )
    await Promise.resolve()
    await Promise.resolve()
    withOrg.mockImplementation(async () => [])
    const read = await withAmbientOrg(() =>
      readEffectiveProjectAccess(
        { viewerIdentityId: VIEWER_ID },
        { extensionName: sharedName, maxInFlight: 1 }
      )
    )
    expect(read).not.toEqual({ outcome: 'error', reasonCode: 'rate-limited' })
    releaseCheck?.()
    await hanging
  })
})
