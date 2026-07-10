import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withOrg } from '@project-vault/db'
import { userIdentityTokens } from '@project-vault/db/schema'
import type { Tx } from '@project-vault/db'
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
import { getRecentAccessEventsForProject } from './recent-access-events.js'

const { createApp, initVault } = await bootstrapRouteIntegrationTest()

type TestApp = Awaited<ReturnType<typeof createApp>>

const PASSWORD = 'correct-horse-battery-staple'
const VALUE_REVEALED = 'credential.value_revealed'

async function registerOwner(app: TestApp, label: string) {
  return registerAndLoginViaApi(app, {
    email: `recent-events-${label}-${randomUUID()}@example.com`,
    password: PASSWORD,
    orgName: `Recent Events ${label} ${randomUUID()}`,
  })
}

// D3 (Story 8.1)/AC-24: `audit_log_entries` rows with actor_type='human' must always carry a
// real, non-null actor_token_id — a database-wide integrity check (checkAuditActorTokenCoverage,
// asserted in backfill-check.test.ts) fails the whole suite otherwise. Every manual audit write
// in this file therefore attributes to a real user_identity_tokens row instead of `null`.
async function createTestActorToken(tx: Tx, displayName: string): Promise<string> {
  const [row] = await tx.insert(userIdentityTokens).values({ displayName }).returning()
  if (!row) throw new Error('expected inserted token row')
  return row.id
}

async function writeCredentialAuditEntry(
  tx: Tx,
  fields: {
    orgId: string
    actorTokenId: string
    eventType: string
    credentialId: string
  }
): Promise<void> {
  await writeHumanAuditEntry(tx, {
    orgId: fields.orgId,
    actorTokenId: fields.actorTokenId,
    eventType: fields.eventType,
    resourceId: fields.credentialId,
    resourceType: 'credential',
    payload: {},
  })
}

describe.sequential('getRecentAccessEventsForProject (AC-A1/A2/A3)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await bootProjectRouteTestApp(createApp, initVault)
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('AC-A1: returns real credential audit events, most-recent-first', async () => {
    const owner = await registerOwner(app, 'multi-event')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'multi-event')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Stripe Key',
      value: 'sk_test',
    })

    // Separate withOrg calls (separate transactions) so each gets a distinct `now()` — Postgres
    // resolves now() once per transaction, so two writes in one transaction would tie.
    await withOrg(owner.orgId, async (tx) => {
      const actorTokenId = await createTestActorToken(tx, 'Alice')
      await writeCredentialAuditEntry(tx, {
        orgId: owner.orgId,
        actorTokenId,
        eventType: VALUE_REVEALED,
        credentialId: credential.id,
      })
    })
    await withOrg(owner.orgId, async (tx) => {
      const actorTokenId = await createTestActorToken(tx, 'Bob')
      await writeCredentialAuditEntry(tx, {
        orgId: owner.orgId,
        actorTokenId,
        eventType: 'credential.tags_updated',
        credentialId: credential.id,
      })
    })

    const events = await withOrg(owner.orgId, (tx) =>
      getRecentAccessEventsForProject(tx, projectId, 10)
    )

    // credential.created (from createCredentialViaApi) + the 2 manually written above = 3.
    expect(events).toHaveLength(3)
    expect(events.map((event) => event.eventType)).toEqual([
      'credential.tags_updated',
      VALUE_REVEALED,
      'credential.created',
    ])
    expect(events.every((event) => event.credentialId === credential.id)).toBe(true)
    expect(events.every((event) => event.credentialName === 'Stripe Key')).toBe(true)
  }, 30_000)

  it('AC-A1: respects the limit parameter', async () => {
    const owner = await registerOwner(app, 'limit')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'limit')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'Limit Key',
      value: 'sk_test',
    })

    await withOrg(owner.orgId, async (tx) => {
      const actorTokenId = await createTestActorToken(tx, 'Limit Actor')
      for (let i = 0; i < 4; i += 1) {
        await writeCredentialAuditEntry(tx, {
          orgId: owner.orgId,
          actorTokenId,
          eventType: VALUE_REVEALED,
          credentialId: credential.id,
        })
      }
    })

    const events = await withOrg(owner.orgId, (tx) =>
      getRecentAccessEventsForProject(tx, projectId, 2)
    )
    // 1 credential.created + 4 credential.value_revealed = 5 total, capped at 2.
    expect(events).toHaveLength(2)
  }, 30_000)

  it('AC-A1 edge / cross-project isolation: a second project`s events never appear in the first project`s list', async () => {
    const owner = await registerOwner(app, 'cross-project')
    const projectA = await createCredentialTestProject(app, owner.cookies, 'cross-a')
    const projectB = await createCredentialTestProject(app, owner.cookies, 'cross-b')
    const credentialA = await createCredentialViaApi(app, owner.cookies, projectA, {
      name: 'Project A Key',
      value: 'sk_a',
    })
    await createCredentialViaApi(app, owner.cookies, projectB, {
      name: 'Project B Key',
      value: 'sk_b',
    })

    const events = await withOrg(owner.orgId, (tx) =>
      getRecentAccessEventsForProject(tx, projectA, 10)
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.credentialId).toBe(credentialA.id)
  }, 30_000)

  it('AC-A2: a project with no credentials returns an empty array', async () => {
    const owner = await registerOwner(app, 'empty')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'empty')

    const events = await withOrg(owner.orgId, (tx) =>
      getRecentAccessEventsForProject(tx, projectId, 10)
    )

    expect(events).toEqual([])
  }, 30_000)

  it('AC-A3: a pseudonymized actor`s row shows their alias, not "unknown"', async () => {
    const owner = await registerOwner(app, 'pseudo-actor')
    const projectId = await createCredentialTestProject(app, owner.cookies, 'pseudo-actor')
    const credential = await createCredentialViaApi(app, owner.cookies, projectId, {
      name: 'DB Password',
      value: 'secret',
    })

    await withOrg(owner.orgId, async (tx) => {
      // Simulates the post-pseudonymization state (org/pseudonymize.ts): the token row survives,
      // only its display_name is overwritten to the generated alias.
      const aliasTokenId = await createTestActorToken(tx, 'user_a1b2c3d4')
      await writeCredentialAuditEntry(tx, {
        orgId: owner.orgId,
        actorTokenId: aliasTokenId,
        eventType: VALUE_REVEALED,
        credentialId: credential.id,
      })
    })

    const events = await withOrg(owner.orgId, (tx) =>
      getRecentAccessEventsForProject(tx, projectId, 10)
    )
    const revealed = events.find((event) => event.eventType === VALUE_REVEALED)
    expect(revealed?.actorDisplayName).toBe('user_a1b2c3d4')
  }, 30_000)

  // AC-A3's "genuinely unresolvable actor" edge (actorTokenId set but absent from the resolved
  // map) is deliberately NOT exercised here with a real DB write: `actor_token_id` is a real FK
  // to `user_identity_tokens(id)` and Story 8.1's D3 database-wide integrity check
  // (checkAuditActorTokenCoverage) forbids actor_type='human' rows with a null/orphaned token, so
  // that state cannot be legitimately constructed via a real write in this test database. Per the
  // AC's own "mocked scenario" framing, that fallback branch is covered by a mocked unit test in
  // `recent-access-events-unknown-actor.test.ts` (map-miss) and by `actor-display-name.test.ts`
  // (`actorDisplayNameFor`'s fallback chain in isolation).
})
