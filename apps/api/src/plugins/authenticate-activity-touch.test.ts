import { beforeEach, describe, expect, it, vi } from 'vitest'

const SESSION_ACTIVITY_MODULE = '../modules/auth/session-activity.js'

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://vault_app:secret@localhost:5432/project_vault',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'fatal',
}

/**
 * Story 8.3 D3/AC-9 — touchActivityWithoutBlocking must wrap touchSessionActivity and
 * touchOrgMembershipActivity in their OWN, separate try/catch blocks, so a failure in one can
 * never suppress the other (resolves adversarial-review finding-11). Mocks both dependencies so
 * this is testable without a real DB, at the exact call-site boundary the fix lives at.
 */
describe('authenticate plugin — independent activity-touch failure isolation (AC-9)', () => {
  beforeEach(() => {
    process.env = { ...process.env, ...BASE_ENV }
    vi.resetModules()
  })

  async function loadTouchActivityWithoutBlocking() {
    const module = await import('./authenticate.js')
    return (
      module as unknown as {
        touchActivityWithoutBlocking: (
          request: { log: { warn: (...args: unknown[]) => void } },
          session: { id: string; orgId: string; userId: string }
        ) => Promise<void>
      }
    ).touchActivityWithoutBlocking
  }

  it('a failure in touchOrgMembershipActivity does not suppress touchSessionActivity', async () => {
    vi.doMock(SESSION_ACTIVITY_MODULE, () => ({
      touchSessionActivity: vi.fn().mockResolvedValue(undefined),
      touchOrgMembershipActivity: vi.fn().mockRejectedValue(new Error('org membership db error')),
    }))
    const { touchSessionActivity, touchOrgMembershipActivity } = await import(
      SESSION_ACTIVITY_MODULE
    )
    const touchActivityWithoutBlocking = await loadTouchActivityWithoutBlocking()

    const warn = vi.fn()
    const request = { log: { warn } }
    const session = { id: 'session-1', orgId: 'org-1', userId: 'user-1' }

    await expect(touchActivityWithoutBlocking(request, session)).resolves.toBeUndefined()

    expect(touchSessionActivity).toHaveBeenCalledWith('session-1', 'org-1')
    expect(touchOrgMembershipActivity).toHaveBeenCalledWith('org-1', 'user-1')
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'org_membership.activity_touch_failed' })
    )
  })

  it('a failure in touchSessionActivity does not suppress touchOrgMembershipActivity', async () => {
    vi.doMock(SESSION_ACTIVITY_MODULE, () => ({
      touchSessionActivity: vi.fn().mockRejectedValue(new Error('session db error')),
      touchOrgMembershipActivity: vi.fn().mockResolvedValue(undefined),
    }))
    const { touchSessionActivity, touchOrgMembershipActivity } = await import(
      SESSION_ACTIVITY_MODULE
    )
    const touchActivityWithoutBlocking = await loadTouchActivityWithoutBlocking()

    const warn = vi.fn()
    const request = { log: { warn } }
    const session = { id: 'session-1', orgId: 'org-1', userId: 'user-1' }

    await expect(touchActivityWithoutBlocking(request, session)).resolves.toBeUndefined()

    expect(touchSessionActivity).toHaveBeenCalledWith('session-1', 'org-1')
    expect(touchOrgMembershipActivity).toHaveBeenCalledWith('org-1', 'user-1')
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'session.activity_touch_failed' })
    )
  })

  it('both touches succeed with no warning logged', async () => {
    vi.doMock(SESSION_ACTIVITY_MODULE, () => ({
      touchSessionActivity: vi.fn().mockResolvedValue(undefined),
      touchOrgMembershipActivity: vi.fn().mockResolvedValue(undefined),
    }))
    const touchActivityWithoutBlocking = await loadTouchActivityWithoutBlocking()

    const warn = vi.fn()
    const request = { log: { warn } }
    const session = { id: 'session-1', orgId: 'org-1', userId: 'user-1' }

    await touchActivityWithoutBlocking(request, session)

    expect(warn).not.toHaveBeenCalled()
  })
})
