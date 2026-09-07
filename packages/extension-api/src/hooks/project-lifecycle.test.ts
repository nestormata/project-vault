import { describe, expect, it } from 'vitest'
import type {
  ProjectArchivedContext,
  ProjectArchiveNotifier,
  ProjectCreateDecision,
  ProjectCreatePolicy,
  ProjectCreatePolicyContext,
} from './project-lifecycle.js'

describe('ProjectCreatePolicy', () => {
  it('returns a typed allow decision for the transaction-scoped create context', async () => {
    const context: ProjectCreatePolicyContext = {
      organizationId: 'org-1',
      actorUserId: 'user-1',
      projectName: 'Payments Production',
      currentProjectCount: 2,
      creationRequestId: '00000000-0000-4000-8000-000000000001',
    }
    const policy: ProjectCreatePolicy = {
      onBeforeCreateProject: async (received) => {
        expect(received).toEqual(context)
        const decision: ProjectCreateDecision = { permitted: true }
        return decision
      },
    }

    await expect(policy.onBeforeCreateProject(context)).resolves.toEqual({ permitted: true })
  })

  it('can fail closed with an opaque reason without receiving tier or billing data', async () => {
    const policy: ProjectCreatePolicy = {
      onBeforeCreateProject: async () => ({
        permitted: false,
        reasonCode: 'project_limit_reached',
        message: 'Project limit reached',
      }),
    }

    await expect(
      policy.onBeforeCreateProject({
        organizationId: 'org-1',
        actorUserId: 'user-1',
        projectName: 'Payments Production',
        currentProjectCount: 3,
        creationRequestId: '00000000-0000-4000-8000-000000000002',
      })
    ).resolves.toMatchObject({ permitted: false, reasonCode: 'project_limit_reached' })
  })
})

// Story 35.1 — ProjectArchiveNotifier is a pure notification (no veto), independent from
// ProjectCreatePolicy/projectLifecycle. These tests only assert the exported types' shape and
// that the hook is a plain fire-and-observe async function — never a decision-returning one.
describe('ProjectArchiveNotifier', () => {
  it('accepts a ProjectArchivedContext and resolves void — a pure notification, not a decision', async () => {
    const context: ProjectArchivedContext = {
      organizationId: 'org-1',
      projectId: 'project-1',
      archivedAt: '2026-09-06T12:00:00.000Z',
      archivedByUserId: 'user-1',
    }
    let received: ProjectArchivedContext | undefined
    const notifier: ProjectArchiveNotifier = {
      onProjectArchived: async (ctx) => {
        received = ctx
      },
    }

    await expect(notifier.onProjectArchived(context)).resolves.toBeUndefined()
    expect(received).toEqual(context)
  })

  it('has no veto/decision return type — the extension cannot block or alter the archive PV already committed', async () => {
    const notifier: ProjectArchiveNotifier = {
      onProjectArchived: async () => {
        throw new Error('extension exploded')
      },
    }

    // The type itself only allows Promise<void> — a throw is the ONLY signal the extension has,
    // and the caller (the worker, not this test) is responsible for isolating it. This test just
    // pins that the interface carries no decision/veto shape at all.
    await expect(
      notifier.onProjectArchived({
        organizationId: 'org-1',
        projectId: 'project-1',
        archivedAt: '2026-09-06T12:00:00.000Z',
        archivedByUserId: 'user-1',
      })
    ).rejects.toThrow('extension exploded')
  })
})
