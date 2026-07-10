import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { userIdentityTokens } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import {
  createCredentialTestProject,
  createCredentialViaApi,
} from '../credentials/credential-route-test-helpers.js'
import { writeHumanAuditEntry } from '../audit/human-entry.js'
import { bootProjectRouteTestApp } from './project-route-test-bootstrap.js'

// AC-A3 edge — "mocked scenario with an actorTokenId that has no matching row in
// displayNameByTokenId at all". A real audit_log_entries row must always carry a valid,
// non-null actor_token_id (Story 8.1 D3's database-wide integrity check forbids otherwise), so
// this simulates "the token row itself no longer exists" the way the AC itself frames it: by
// mocking the resolver's map to come back empty, not by writing an invariant-violating row.
vi.mock('../audit/actor-display-name.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit/actor-display-name.js')>()
  return {
    ...actual,
    batchResolveActorDisplayNames: vi.fn().mockResolvedValue(new Map()),
  }
})

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'

async function registerOwner(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: `recent-events-unknown-${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `Recent Events Unknown ${label} ${randomUUID()}`,
  })
}

describe('getRecentAccessEventsForProject — AC-A3 edge (mocked map-miss)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('renders "unknown" without throwing when the resolved display-name map has no entry for a real actorTokenId', async () => {
    const owner = await registerOwner(app, 'unresolvable-actor')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'unresolvable-actor')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'API Token',
      value: 'secret',
    })

    await withOrg(owner.orgId, async (tx) => {
      const [token] = await tx
        .insert(userIdentityTokens)
        .values({ displayName: 'Some Real Name' })
        .returning()
      if (!token) throw new Error('expected inserted token row')
      await writeHumanAuditEntry(tx, {
        orgId: owner.orgId,
        actorTokenId: token.id,
        eventType: 'credential.dependency_added',
        resourceId: credential.id,
        resourceType: 'credential',
        payload: {},
      })
    })

    // Imported after the mock is registered so the mocked batchResolveActorDisplayNames is used.
    const { getRecentAccessEventsForProject } = await import('./recent-access-events.js')

    const events = await withOrg(owner.orgId, (tx) =>
      getRecentAccessEventsForProject(tx, projectId, 10)
    )
    const added = events.find((event) => event.eventType === 'credential.dependency_added')
    expect(added?.actorDisplayName).toBe('unknown')
  }, 30_000)
})
