import type {
  ExtensionHooks,
  ExtensionManifest,
  ModuleAction,
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
    // Story 25.5 AC4/Task 4 — when `actionEndpoint` is present (declared moduleActions), renders
    // a real button that dispatches the action via `postMessage` to the host page, which relays
    // the real, authenticated fetch on this panel's behalf and posts the result back.
    //
    // Bug fix (2026-08-24, found via real Chrome-driven manual verification): this originally
    // had the button `fetch(actionEndpoint, ...)` directly from inside the panel iframe. That
    // can never work — the iframe's `sandbox="allow-scripts"` (no `allow-same-origin`, a
    // non-negotiable Story 25.1 requirement) forces it into an opaque origin, so any fetch it
    // issues is cross-origin by definition and `credentials: 'same-origin'` never attaches the
    // session cookie, regardless of CSP. The panel no longer knows or needs `actionEndpoint`'s
    // URL at all — it only needs to know actions are available (this fixture still gates the
    // button's existence on that), and sends the action `kind` to the host via `postMessage`;
    // the host owns resolving and fetching the real endpoint. See `+page.svelte`'s message-relay
    // handler for the host side of this exchange.
    return {
      html:
        `<html><body>` +
        `<p style="color: var(--pv-ext-ink, #24323b); background: var(--pv-ext-surface, #ffffff);">Mock panel for slot "${context.slot}"</p>` +
        (context.actionEndpoint
          ? `<button id="test-action-button" type="button">Run test action</button>` +
            `<p id="test-action-result" aria-live="polite"></p>` +
            `<script>
              document.getElementById('test-action-button').addEventListener('click', () => {
                const resultEl = document.getElementById('test-action-result');
                const requestId = Math.random().toString(36).slice(2);
                function handleResult(event) {
                  const data = event.data;
                  if (!data || data.source !== 'pv-extension-panel-action-result' || data.requestId !== requestId) return;
                  window.removeEventListener('message', handleResult);
                  resultEl.textContent = data.ok
                    ? 'status:' + data.status + ' message:' + (data.message || '')
                    : 'fetch-failed';
                }
                window.addEventListener('message', handleResult);
                parent.postMessage(
                  { source: 'pv-extension-panel-action', requestId: requestId, kind: ${JSON.stringify(TEST_ACTION_KIND)} },
                  '*'
                );
              });
            </script>`
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
    return { outcome: 'ok', message: `test-action executed for slot "${context.slot}"` }
  },
}

function hooksFactory(): ExtensionHooks {
  return { uiPanel, moduleAction }
}

export default { manifest, hooksFactory }
