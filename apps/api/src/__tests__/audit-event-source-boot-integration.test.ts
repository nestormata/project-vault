import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { auditLogEntries } from '@project-vault/db/schema'
import { bootstrapRouteIntegrationTest, initVaultForTest } from './helpers/auth-test-helpers.js'
import { resetVaultForTest } from './helpers/vault-test-cleanup.js'
import {
  loadExtension,
  getExtensionStatus,
  __resetExtensionStateForTests,
} from '../extensions/loader.js'

const FIXTURE_PACKAGE_NAME = '@project-vault/mock-audit-event-source-extension'
const TEST_PASSPHRASE = 'audit-event-source-boot-integration-passphrase'

/**
 * Story 23.8 AC-27 — the mandatory end-to-end proof: drives the REAL `loadExtension()` against
 * the REAL, dynamically-`import()`-ed `@project-vault/mock-audit-event-source-extension` package
 * (not a hand-injected mock), exercising the actual `registerExtension()` -> `buildHostServices()`
 * -> `hooksFactory(host)` wiring `apps/api/src/extensions/loader.ts` performs, then calls the
 * fixture's own `triggerAuditWrite()` (module singleton — this spec runs in the same Node process
 * as the dynamically-imported fixture, the same technique `mock-capability-gate-extension`'s own
 * boot-integration test uses) to drive a real write through the real host wiring.
 *
 * Deliberately does NOT boot the full `createApp()`/Fastify HTTP surface the way Story 23.3's
 * `capability-gate-boot-integration.test.ts` does: `AuditEventSourceHost`'s effect
 * (`writeAuditEvent()`) is entirely and directly observable through `loader.ts`'s own exported
 * `loadExtension()` + the fixture's captured `host` — no HTTP route depends on this hook, unlike
 * `CapabilityGate`, which can only be observed by exercising a gated route. Booting the full app
 * here would pull in vault/auth/route registration machinery this hook has no dependency on.
 *
 * Story 23.8 environment finding (documented per AGENTS.md's "fix or document real environment
 * gaps" instruction, PRE-EXISTING and NOT introduced by this story): an earlier version of this
 * test booted the full `createApp()` (mirroring Story 23.3's `capability-gate-boot-integration.
 * test.ts` pattern exactly). Run together with that file in the same `vitest run` invocation
 * (`apps/api/vitest.config.ts` sets `fileParallelism: false`, so the whole package's suite runs
 * in one non-isolated worker), `capability-gate-boot-integration.test.ts` reliably 500'd on every
 * route (`/api/v1/auth/register` included) — a real Postgres query failure inside route handlers,
 * confirmed via debug logging, while a bare `getDb()` query on the same connection succeeded fine.
 * **Root-caused via `git stash` + a minimal repro: this is a PRE-EXISTING bug in
 * `capability-gate-boot-integration.test.ts` itself, unrelated to any code this story adds.**
 * Pairing ANY pre-existing test file that calls `resetVaultForTest()` + `initVaultForTest()`
 * (e.g. `src/modules/audit/s3-forward.test.ts`, on `main`, with zero Story 23.8 changes applied)
 * immediately before `capability-gate-boot-integration.test.ts` in one `vitest run` invocation
 * reproduces the identical 500s — this story's own boot-integration test was never the cause, it
 * merely exposed a pre-existing test-isolation gap the very first time TWO real-boot-adjacent
 * files happened to be selected together on one `vitest run <file> <file>` command line (the full
 * suite's default file discovery/ordering apparently avoids ever triggering this combination
 * today). This test structurally avoids re-triggering it anyway (see above: no `createApp()`
 * call), so it does not regress `capability-gate-boot-integration.test.ts` either way. Left for a
 * future session to properly root-cause and fix (starting point: whether
 * `capability-gate-boot-integration.test.ts`'s own `vault`/`extensions/loader.ts` singletons
 * survive a *preceding* file's `resetVaultForTest()` cycle correctly) — out of this story's scope.
 */
describe.sequential('Story 23.8 AC-27 — real boot with mock-audit-event-source-extension', () => {
  beforeAll(async () => {
    await resetVaultForTest()
    const { initVault } = await bootstrapRouteIntegrationTest()
    await initVaultForTest(initVault, TEST_PASSPHRASE)
  }, 30_000)

  afterEach(() => {
    __resetExtensionStateForTests()
  })

  afterAll(async () => {
    __resetExtensionStateForTests()
    await resetVaultForTest()
  })

  it('the fixture extension is genuinely loaded via the real loadExtension() (not a hand-injected mock)', async () => {
    await loadExtension(FIXTURE_PACKAGE_NAME)

    const state = getExtensionStatus()
    expect(state.status).toBe('loaded')
    expect(state.status === 'loaded' && state.manifest.name).toBe(
      'test.mock-audit-event-source-extension'
    )
    expect(state.status === 'loaded' && state.manifest.capabilities).toEqual(['audit-event-source'])
  })

  it('triggerAuditWrite drives a real write through the real host wiring; the row is discoverable with the correct actor_type/eventType/payload', async () => {
    await loadExtension(FIXTURE_PACKAGE_NAME)
    const fixtureModule = await import('@project-vault/mock-audit-event-source-extension')

    await withTestOrg(async ({ orgId }) => {
      const eventType = `ext.${fixtureModule.MOCK_AUDIT_EVENT_SOURCE_PROVIDER_NAME}.fixture_triggered`
      const result = await fixtureModule.triggerAuditWrite({
        eventType,
        orgId,
        resourceId: crypto.randomUUID(),
        resourceType: 'fixture',
        payload: { triggeredBy: 'boot-integration-test' },
      })

      expect(result.id).toBeTruthy()
      expect(result.createdAt).toBeTruthy()

      const [row] = await withOrg(orgId, (tx) =>
        tx.select().from(auditLogEntries).where(eq(auditLogEntries.id, result.id))
      )

      expect(row).toBeDefined()
      expect(row?.actorType).toBe('extension')
      expect(row?.eventType).toBe(eventType)
      expect(row?.actorTokenId).toBeNull()
      expect((row?.payload as Record<string, unknown> | undefined)?.['extensionName']).toBe(
        fixtureModule.MOCK_AUDIT_EVENT_SOURCE_PROVIDER_NAME
      )
      expect((row?.payload as Record<string, unknown> | undefined)?.['triggeredBy']).toBe(
        'boot-integration-test'
      )
    })
  })

  it('rejects an eventType outside the loaded extension namespace, before any transaction opens', async () => {
    await loadExtension(FIXTURE_PACKAGE_NAME)
    const fixtureModule = await import('@project-vault/mock-audit-event-source-extension')

    await expect(
      fixtureModule.triggerAuditWrite({
        eventType: 'ext.com.other.extension.thing_happened',
        orgId: 'org-does-not-matter',
        payload: {},
      })
    ).rejects.toThrow(/namespace|ext\./i)
  })
})
