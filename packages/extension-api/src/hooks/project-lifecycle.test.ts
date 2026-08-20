import { describe, expect, it } from 'vitest'
import type {
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
