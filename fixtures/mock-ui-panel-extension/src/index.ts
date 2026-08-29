import type {
  ExtensionHooks,
  ExtensionManifest,
  ModuleAction,
  ModuleDataRouteHandler,
  UIPanel,
} from '@project-vault/extension-api'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'

/**
 * Story 25.1 Task 7 — a self-contained, in-process mock UI-panel extension. Exists so the real
 * boot path (`loadExtension()` -> `GET /api/v1/extensions/panels/:slot` -> `onRenderPanel()`) can
 * be exercised end-to-end, in Chrome-driven manual verification, without wiring up
 * CentralizeMe's real `access-group/ui-panel.ts` (which cannot render meaningfully until Story
 * 25.3 adds `resourceId` to `UIPanelContext` — see this story's Dev Notes Assumption Audit).
 *
 * It declares only the `ui-panel` capability and implements exactly one hook. Its
 * `onRenderPanel()` result is driven by the requested `slot`, deterministically, with no
 * network call and no real content — three reserved slot values additionally exercise AC3's
 * degraded-path mechanics on demand, for manual QA:
 *
 * | slot value        | `onRenderPanel` behavior                          | Exercises              |
 * | ------------------ | -------------------------------------------------- | ----------------------- |
 * | `group`             | resolves a small static HTML fragment              | AC1/AC4 happy path      |
 * | `fixture-throw`      | throws synchronously                                | AC3 fail-closed-on-throw |
 * | `fixture-hang`       | never resolves                                      | AC3 fail-closed-on-timeout |
 * | `fixture-garbage`    | resolves a malformed result                          | AC3 fail-closed-on-malformed |
 * | `fixture-context-echo` | renders every context field back as visible text | Story 25.3 AC1-AC5 verification |
 *
 * Story 25.2 AC6 — this manifest now declares `uiPanelSlots` explicitly, covering all four slots
 * above. This closes the gap this file's own comment (and the README) used to flag: Story 25.1's
 * route hardcoded exactly one valid slot (`'group'`) and rejected every other value with a 400
 * before ever invoking this hook — so exercising the `fixture-*` trigger slots required either
 * driving `hooksFactory()` directly in a unit test, or temporarily editing
 * `KNOWN_UI_PANEL_SLOTS` (apps/api/src/lib/extension-panel.ts). Story 25.2's dynamic
 * `resolveKnownUiPanelSlots()` makes that workaround unnecessary: every slot this manifest
 * declares is now reachable via an ordinary `GET /api/v1/extensions/panels/:slot` request.
 *
 * Story 25.3 Task 5 — `fixture-context-echo` renders every field of the widened `UIPanelContext`
 * (`identity.userId`, `identity.orgRole`, `orgId`, `projectId`, `resourceId`, `locale`,
 * `theme.name`) into its returned HTML as plain visible text, so both this story's own tests and
 * any later Chrome-driven manual verification can assert against real rendered text instead of
 * needing to parse opaque HTML.
 */
export const MOCK_UI_PANEL_PROVIDER_NAME = 'test.mock-ui-panel-extension'

export const HAPPY_SLOT = 'group'
export const THROW_TRIGGER_SLOT = 'fixture-throw'
export const HANG_TRIGGER_SLOT = 'fixture-hang'
export const GARBAGE_TRIGGER_SLOT = 'fixture-garbage'
export const CONTEXT_ECHO_SLOT = 'fixture-context-echo'
export const TEST_ACTION_KIND = 'test-action'
/**
 * Story 25.12 AC1/Task 6 — a real field beyond `kind`, so this fixture's own action postMessage
 * exercises the widened ACTION relay's full-payload-forwarding fix end to end (rather than only
 * a synthetic multi-field message constructed in a test file). `onAction` below echoes it back in
 * its `message`, giving both unit tests and Chrome-driven manual verification something visible
 * to assert the field actually reached the server intact.
 */
export const TEST_ACTION_NOTE = 'fixture-note'
/**
 * Story 25.12 AC2/Task 6 — a new DATA-relay path declared beyond the legacy
 * `/api/v1/projects`/`/api/v1/projects/:id` default, giving this story's own AC2 happy-path test
 * (and Chrome-driven manual verification) a real, manifest-declared end-to-end target.
 */
export const TEST_DATA_PATH = '/api/v1/org/users'
/**
 * Story 29.3 AC13 — a real, manifest-declared `navItems` target: one top-level item plus one
 * child, giving this story's own new tests (nav-model.test.ts's merge logic, PrimaryNav.test.ts's
 * icon/disclosure rendering) — and any later Chrome-driven manual verification — a real
 * end-to-end fixture, following this fixture's own established pattern of exporting named
 * constants for tests to reference.
 */
export const TEST_NAV_ITEM_ID = 'mock-ext-settings'
export const TEST_NAV_CHILD_ITEM_ID = 'mock-ext-settings-child'
/**
 * Story 29.4 AC10/Task 5 — a real, manifest-declared `moduleDataRoutes` target: the mounted route
 * (per AC2) is `GET /api/v1/extensions/data/fixture-echo`, giving this story's own tests — and any
 * later Chrome-driven manual verification — a real end-to-end fixture, following this fixture's
 * own established named-constant-export pattern.
 */
export const TEST_MODULE_DATA_PATH = '/fixture-echo'

const manifest: ExtensionManifest = {
  name: MOCK_UI_PANEL_PROVIDER_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['ui-panel'],
  // Story 25.2 AC6 — declares all four fixture slots, making the throw/hang/garbage triggers
  // reachable through the real HTTP route rather than only via a direct hooksFactory() call.
  // Story 25.3 Task 5 — adds the context-echo slot.
  uiPanelSlots: [
    HAPPY_SLOT,
    THROW_TRIGGER_SLOT,
    HANG_TRIGGER_SLOT,
    GARBAGE_TRIGGER_SLOT,
    CONTEXT_ECHO_SLOT,
  ],
  // Story 25.5 AC4/Task 4 — declaring at least one moduleAction makes apps/api populate
  // UIPanelContext.actionEndpoint, which this fixture's panel uses to gate rendering its action
  // button, so this fixture's own panel can exercise the real end-to-end action round trip (via
  // the postMessage relay to the host — see onRenderPanel's own comment) in Chrome-driven manual
  // verification, not just a direct handleModuleAction() unit test.
  moduleActions: [TEST_ACTION_KIND],
  // Story 25.12 AC2/Task 6 — declares the legacy default pair explicitly (so this fixture's
  // behavior for those two paths is unchanged) plus TEST_DATA_PATH, a real end-to-end target for
  // this story's AC2 happy-path test and Chrome-driven manual verification.
  // @deprecated Story 29.4 — superseded by moduleDataRoutes below; kept so this fixture still
  // exercises the deprecated-but-still-validatable field per AC8's deprecate-in-place decision.
  panelDataPaths: ['/api/v1/projects', '/api/v1/projects/:id', TEST_DATA_PATH],
  // Story 29.4 AC1/AC10/Task 5 — the real replacement mechanism: a single declared GET route,
  // mounted at GET /api/v1/extensions/data/fixture-echo (AC2), with a matching `moduleData`
  // handler below returning a fixed, deterministic body.
  moduleDataRoutes: [{ method: 'GET', path: TEST_MODULE_DATA_PATH }],
  // Story 29.3 AC1/AC13 — declared alongside 'ui-panel' purely because this fixture already
  // declares it (navItems is NOT gated behind 'ui-panel' — a fixture declaring only
  // 'notification-channel' would be equally valid). One top-level item plus one child, exercising
  // both the flat top-level merge and the one-level-nesting disclosure end to end.
  navItems: [
    { id: TEST_NAV_ITEM_ID, label: 'Mock Extension Settings', href: '/dashboard', icon: 'grid' },
    {
      id: TEST_NAV_CHILD_ITEM_ID,
      label: 'Mock Child Page',
      href: '/health',
      parentId: TEST_NAV_ITEM_ID,
    },
  ],
}

const uiPanel: UIPanel = {
  async onRenderPanel(context) {
    if (context.slot === THROW_TRIGGER_SLOT) {
      throw new Error('mock-ui-panel-extension: deterministic throw trigger')
    }
    if (context.slot === HANG_TRIGGER_SLOT) {
      // Never resolves — exercises the host's timeout (AC3).
      return new Promise(() => undefined)
    }
    if (context.slot === GARBAGE_TRIGGER_SLOT) {
      // Deliberately malformed — exercises the host's shape-check boundary (AC3).
      return { html: 42 } as unknown as { html: string }
    }
    if (context.slot === CONTEXT_ECHO_SLOT) {
      return {
        html:
          '<html><body>' +
          `<p data-field="userId">userId:${context.identity.userId}</p>` +
          `<p data-field="orgRole">orgRole:${context.identity.orgRole}</p>` +
          `<p data-field="orgId">orgId:${context.orgId}</p>` +
          `<p data-field="projectId">projectId:${context.projectId ?? ''}</p>` +
          `<p data-field="resourceId">resourceId:${context.resourceId ?? ''}</p>` +
          `<p data-field="locale">locale:${context.locale}</p>` +
          `<p data-field="themeName">themeName:${context.theme.name ?? ''}</p>` +
          '</body></html>',
      }
    }
    // Story 25.4 AC4 Task 4 — consumes PV's small, published `--pv-ext-*` theming contract
    // (`EXTENSION_THEME_CSS_VARS`, `@project-vault/extension-api`) the same way CentralizeMe's
    // real `access-group/ui-panel.ts` already does for its own `--cm-*` custom properties: a CSS
    // `var()` reference with a hardcoded fallback, so this fixture still renders sensibly even
    // outside PV's host (e.g. a standalone preview) and visibly picks up PV's real theme colors
    // once composed by `apps/web`'s panel-document composition function.
    //
    // Story 29.2 AC1/AC13 — when `actionEndpoint` is present (declared `moduleActions`), renders
    // a real button declared purely declaratively via `data-pv-action`/`data-pv-action-<field>`
    // attributes — no `id`, no inline `<script>`, no manual `postMessage` wiring. The host
    // (`+page.svelte`'s single delegated click handler) discovers this button, resolves it via
    // `.closest('[data-pv-action]')`, extracts `kind` plus every `data-pv-action-<field>`
    // attribute into the request body, and dispatches the real same-origin fetch directly —
    // the panel no longer knows or needs `actionEndpoint`'s URL at all, exactly as before, but
    // now via a data-attribute contract Story 29.1's DOMPurify sanitizer actually lets survive
    // (unlike the inline `<script>` this markup used to require, which that sanitizer strips
    // unconditionally — see this fixture's own git history / Story 29.1's Dev Notes "AC7
    // disposition" for the interim regression this story fixes). The host also owns rendering the
    // action's result generically (a status message, or a replaced panel `html`) — this fixture
    // needs no result-echoing markup of its own any more.
    //
    // `data-pv-action-note` carries a real field beyond `kind` (`TEST_ACTION_NOTE`), so this
    // fixture's own action button exercises the full request-body-assembly path end to end
    // (Story 25.12 AC1's original forwarding-fix precedent, now reused by the new mechanism).
    return {
      html:
        `<html><body>` +
        `<p style="color: var(--pv-ext-ink, #24323b); background: var(--pv-ext-surface, #ffffff);">Mock panel for slot "${context.slot}"</p>` +
        (context.actionEndpoint
          ? `<button type="button" data-pv-action="${TEST_ACTION_KIND}" data-pv-action-note="${TEST_ACTION_NOTE}">Run test action</button>`
          : '') +
        `</body></html>`,
    }
  },
}

const moduleAction: ModuleAction = {
  async onAction(context, request) {
    if (request.action.kind !== TEST_ACTION_KIND) {
      return { outcome: 'validation_failed', message: 'Unknown action kind' }
    }
    // Story 25.12 AC1/Task 6 — echoes the `note` field back in the message so both this
    // fixture's own tests and Chrome-driven manual verification (Task 8) can assert the widened
    // ACTION relay actually forwarded this field beyond `kind` — before this story, `note` never
    // reached this handler at all, since the relay dropped every field but `kind`.
    const note = request.action['note']
    const noteSuffix = typeof note === 'string' ? ` with note "${note}"` : ''
    return {
      outcome: 'ok',
      message: `test-action executed for slot "${context.slot}"${noteSuffix}`,
    }
  },
}

/**
 * Story 29.4 AC3/AC10/Task 5 — the matching handler for TEST_MODULE_DATA_PATH's `moduleDataRoutes`
 * declaration, keyed by the exact `"GET <path>"` string `registerExtension()` cross-checks at load
 * time. Returns a fixed, deterministic body echoing the caller's own `orgId` (proving the real
 * per-request context — never a shared/memoized value — reaches the module's handler), giving this
 * story's own end-to-end tests a real target beyond "it compiles".
 */
const fixtureEchoModuleData: ModuleDataRouteHandler = async (context) => ({
  body: { ok: true, orgId: context.orgId, userId: context.identity.userId },
})

function hooksFactory(): ExtensionHooks {
  return {
    uiPanel,
    moduleAction,
    moduleData: { [`GET ${TEST_MODULE_DATA_PATH}`]: fixtureEchoModuleData },
  }
}

export default { manifest, hooksFactory }
