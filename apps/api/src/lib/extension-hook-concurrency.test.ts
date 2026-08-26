import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'
import type { UIPanel } from '@project-vault/extension-api'
import { createApp } from '../app.js'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import {
  DEFAULT_UI_PANEL_SLOTS,
  renderExtensionPanel,
  type RenderExtensionPanelDeps,
} from './extension-panel.js'

// Mirrors routes/health.test.ts's env mock exactly — this test only needs createApp() to boot
// far enough to serve GET /health (no DB, no vault) as the concurrent, unrelated request.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'api',
    TRUST_PROXY: false,
    TRUST_PROXY_HOPS: 1,
  },
}))

function loadedState(uiPanel: UIPanel): ExtensionState {
  return {
    status: 'loaded',
    manifest: {
      name: 'com.example.hang-fixture',
      apiVersion: '1.0.0',
      capabilities: ['ui-panel'],
      uiPanelSlots: ['group'],
    },
    loadedAt: new Date().toISOString(),
    hooks: { uiPanel },
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}

const FAKE_TX = {} as Tx

function fakeDeps(): RenderExtensionPanelDeps {
  return {
    callerCanSeeProject: vi.fn(async () => true),
    logVisibilityDenied: vi.fn(),
    getUserLocale: vi.fn(async () => 'en' as const),
    resolveTheme: vi.fn(async () => ({ name: null })),
  }
}

const IDENTITY = { userId: 'user_1', orgId: 'org_1', orgRole: 'member' as const }

/**
 * Story 25.7 AC3 — the concurrency-isolation proof this story adds: no test before this one ever
 * asserted that a genuinely hanging hook call leaves PV's own event loop free to service an
 * unrelated, concurrent request. Every existing per-call-site "degrades to unavailable on
 * timeout" test (e.g. extension-panel.test.ts) only proves the HANGING request itself eventually
 * times out — never that OTHER traffic keeps flowing while it's still in flight.
 *
 * Uses a real, never-resolving promise (mirroring `mock-ui-panel-extension`'s own
 * `HANG_TRIGGER_SLOT` fixture) racing against a real, concurrently dispatched `GET /health`
 * request — not a mocked/faked timeout, per the story's own Testing Requirements.
 *
 * Dev Notes "Synchronous-blocking limitation": this proves isolation against an ASYNC hang
 * specifically (the realistic "slow/hanging extension" case, since Node's event loop is only
 * blocked by synchronous CPU work). It does not and cannot prove isolation against a
 * synchronous, CPU-bound hook — that is an accepted, explicitly out-of-scope limitation of
 * `raceWithTimeout()` itself, not something this test claims to cover.
 */
describe('Extension hook concurrency isolation (Story 25.7 AC3)', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('a hanging onRenderPanel call does not block a concurrent, unrelated /health request from completing promptly', async () => {
    const app = await createApp({ logger: false })
    try {
      __setExtensionStateForTests(
        loadedState({
          // Never resolves — a genuine hang, not a slow-but-eventually-resolving call.
          onRenderPanel: () => new Promise(() => undefined),
        })
      )

      // Fired but deliberately not awaited yet — this call is still in flight (racing against
      // the real RENDER_PANEL_TIMEOUT_MS = 10_000ms wrapper) while the concurrent request below
      // is dispatched and asserted on.
      const hangingPanelPromise = renderExtensionPanel(
        'group',
        DEFAULT_UI_PANEL_SLOTS,
        silentLogger(),
        IDENTITY,
        FAKE_TX,
        {},
        fakeDeps()
      )

      const start = Date.now()
      const healthResponse = await app.inject({ method: 'GET', url: '/health' })
      const elapsedMs = Date.now() - start

      expect(healthResponse.statusCode).toBe(200)
      // Well under the 10_000ms RENDER_PANEL_TIMEOUT_MS the hanging call above is still waiting
      // on at this point — proves PV's own event loop was never blocked by the in-flight hang,
      // not merely that the hanging request itself eventually times out.
      expect(elapsedMs).toBeLessThan(2_000)

      // Let the still-in-flight hang resolve via its own real timeout before this test ends, so
      // no background timer outlives it.
      const raced = await hangingPanelPromise
      expect(raced).toEqual({ outcome: 'unavailable' })
    } finally {
      await app.close()
    }
  }, 15_000)
})
