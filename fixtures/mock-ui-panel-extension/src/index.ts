import type { ExtensionHooks, ExtensionManifest, UIPanel } from '@project-vault/extension-api'
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
 *
 * Story 25.2 AC6 — this manifest now declares `uiPanelSlots` explicitly, covering all four slots
 * above. This closes the gap this file's own comment (and the README) used to flag: Story 25.1's
 * route hardcoded exactly one valid slot (`'group'`) and rejected every other value with a 400
 * before ever invoking this hook — so exercising the `fixture-*` trigger slots required either
 * driving `hooksFactory()` directly in a unit test, or temporarily editing
 * `KNOWN_UI_PANEL_SLOTS` (apps/api/src/lib/extension-panel.ts). Story 25.2's dynamic
 * `resolveKnownUiPanelSlots()` makes that workaround unnecessary: every slot this manifest
 * declares is now reachable via an ordinary `GET /api/v1/extensions/panels/:slot` request.
 */
export const MOCK_UI_PANEL_PROVIDER_NAME = 'test.mock-ui-panel-extension'

export const HAPPY_SLOT = 'group'
export const THROW_TRIGGER_SLOT = 'fixture-throw'
export const HANG_TRIGGER_SLOT = 'fixture-hang'
export const GARBAGE_TRIGGER_SLOT = 'fixture-garbage'

const manifest: ExtensionManifest = {
  name: MOCK_UI_PANEL_PROVIDER_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['ui-panel'],
  // Story 25.2 AC6 — declares all four fixture slots, making the throw/hang/garbage triggers
  // reachable through the real HTTP route rather than only via a direct hooksFactory() call.
  uiPanelSlots: [HAPPY_SLOT, THROW_TRIGGER_SLOT, HANG_TRIGGER_SLOT, GARBAGE_TRIGGER_SLOT],
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
    // Story 25.4 AC4 Task 4 — consumes PV's small, published `--pv-ext-*` theming contract
    // (`EXTENSION_THEME_CSS_VARS`, `@project-vault/extension-api`) the same way CentralizeMe's
    // real `access-group/ui-panel.ts` already does for its own `--cm-*` custom properties: a CSS
    // `var()` reference with a hardcoded fallback, so this fixture still renders sensibly even
    // outside PV's host (e.g. a standalone preview) and visibly picks up PV's real theme colors
    // once composed by `apps/web`'s panel-document composition function.
    return {
      html: `<html><body><p style="color: var(--pv-ext-ink, #24323b); background: var(--pv-ext-surface, #ffffff);">Mock panel for slot "${context.slot}"</p></body></html>`,
    }
  },
}

function hooksFactory(): ExtensionHooks {
  return { uiPanel }
}

export default { manifest, hooksFactory }
