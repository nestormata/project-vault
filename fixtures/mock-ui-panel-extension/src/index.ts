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
 * | `fixture-throw`      | throws synchronously                                | AC3 fail-closed-on-throw (unreachable via this story's own route — its own slot-allowlist rejects any value other than `group` with a 400 before the hook is ever called; kept here for a future story's own slot enumeration and for direct hooksFactory()-level testing) |
 * | `fixture-hang`       | never resolves                                      | AC3 fail-closed-on-timeout (same allowlist caveat as above) |
 * | `fixture-garbage`    | resolves a malformed result                          | AC3 fail-closed-on-malformed (same allowlist caveat as above) |
 *
 * Story 25.1's own route hardcodes exactly one valid slot (`'group'`) and rejects every other
 * value with a 400 before ever invoking this hook (AC3b) — so a manual verifier driving Task 7's
 * "simulate a hook failure" step should temporarily point `KNOWN_UI_PANEL_SLOTS`
 * (apps/api/src/lib/extension-panel.ts) at one of the `fixture-*` slots above, or drive this
 * fixture's `hooksFactory()` directly in a unit test, rather than expecting the real HTTP route to
 * reach them with today's single-slot allowlist.
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
    return {
      html: `<html><body><p>Mock panel for slot "${context.slot}"</p></body></html>`,
    }
  },
}

function hooksFactory(): ExtensionHooks {
  return { uiPanel }
}

export default { manifest, hooksFactory }
