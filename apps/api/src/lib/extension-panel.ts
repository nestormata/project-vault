import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { getExtensionStatus } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import { operationalLog } from './logger.js'
import { raceWithTimeout } from './race-with-timeout.js'

/**
 * Story 25.1 AC5/Dev Notes: the legacy fixed single-slot list, matching a real slot name
 * CentralizeMe's own `access-group/ui-panel.ts` consumer already expects ('group', not a
 * generic placeholder like 'default'). Story 25.2 AC2 turns this into the backward-compatible
 * fallback used when a loaded extension's manifest omits `uiPanelSlots` — never mutated, never
 * grown; `resolveKnownUiPanelSlots` below is what derives the real, extension-declared list.
 */
export const DEFAULT_UI_PANEL_SLOTS = ['group'] as const
export type KnownUiPanelSlot = (typeof DEFAULT_UI_PANEL_SLOTS)[number]

type LoadedExtensionState = Extract<ExtensionState, { status: 'loaded' }>

/**
 * Story 25.2 AC2 — tracks the identity (`name:loadedAt`) of the extension load this module has
 * already warned about, so the fallback log fires exactly once per load, never once per request.
 * `loadedAt` is part of the identity so a mid-process reload (a genuinely new load, AC3's
 * Boundary & Edge Case Sweep finding) re-warns rather than staying silent forever after the
 * first-ever load.
 */
let lastFallbackWarnedLoadIdentity: string | undefined

/** Test-only reset of this module's one-time-warning state — never called from production code. */
export function __resetUiPanelSlotsFallbackWarningForTests(): void {
  lastFallbackWarnedLoadIdentity = undefined
}

function warnUiPanelSlotsFallbackOnce(status: LoadedExtensionState, logger: PanelLogger): void {
  const loadIdentity = `${status.manifest.name}:${status.loadedAt}`
  if (lastFallbackWarnedLoadIdentity === loadIdentity) return
  lastFallbackWarnedLoadIdentity = loadIdentity
  operationalLog(
    logger,
    'warn',
    OperationalEvent.EXTENSION_UI_PANEL_SLOTS_FALLBACK,
    'Extension declares ui-panel without an explicit uiPanelSlots list — running on the legacy single-slot ("group") fallback',
    { extensionName: status.manifest.name }
  )
}

/**
 * Story 25.2 AC3/Task 2 — derives the effective known-slots list for `renderExtensionPanel()`'s
 * `knownSlots` allowlist parameter, freshly on every call (never memoized/cached at module
 * scope — a mid-process reload with a different declared list must resolve against the new list
 * on the very next call, per AC3's Boundary & Edge Case Sweep finding).
 *
 * Story 25.2 AC4 — reads `getExtensionStatus()`'s single loaded-extension value directly; there
 * is no multi-extension registry here and none is in scope for this story (PV loads at most one
 * extension package at a time — see `apps/api/src/extensions/loader.ts`'s `ExtensionState`).
 *
 * When no extension is loaded, or the loaded extension omits `uiPanelSlots` (AC2), returns the
 * exact same fixed `DEFAULT_UI_PANEL_SLOTS` Story 25.1 shipped — zero behavior change for any
 * pre-25.2 extension package, with a one-time warn log on the fallback path.
 */
export function resolveKnownUiPanelSlots(
  status: ExtensionState | undefined,
  logger: PanelLogger
): readonly string[] {
  if (!status || status.status !== 'loaded') return DEFAULT_UI_PANEL_SLOTS

  const declared = status.manifest.uiPanelSlots
  if (declared && declared.length > 0) return declared

  warnUiPanelSlotsFallbackOnce(status, logger)
  return DEFAULT_UI_PANEL_SLOTS
}

/**
 * AC3: generous enough for a synchronous-shaped render call, short enough not to hang a page
 * load. Story 25.7 will formalize a project-wide timeout policy across all hook calls — this
 * story's own value is a reasonable interim default, not a final policy decision.
 */
const RENDER_PANEL_TIMEOUT_MS = 10_000

export type RenderExtensionPanelResult =
  { outcome: 'invalid_slot' } | { outcome: 'unavailable' } | { outcome: 'ok'; html: string }

type PanelLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>

function logUnavailable(
  logger: PanelLogger,
  slot: string,
  subReason: 'not_loaded' | 'timed_out' | 'threw' | 'malformed'
): void {
  // AC3: the hook's actual thrown error/timeout detail is never included here — logged
  // server-side only, as a fixed-enum subReason, matching this codebase's existing
  // never-leak-internal-detail discipline (mirrors capability-gate.ts's own pattern).
  operationalLog(
    logger,
    'error',
    OperationalEvent.EXTENSION_UI_PANEL_UNAVAILABLE,
    'Extension UI panel unavailable',
    { slot, subReason }
  )
}

/**
 * Story 25.1 Task 2 — the reusable safety net Story 25.2 (more slots) and any future panel route
 * will also need: slot validation, fresh status re-check (AC3's Boundary & Edge Case Sweep
 * finding — the loaded extension can genuinely be gone by request time even though it was valid
 * when a nav entry was rendered), timeout wrapping via the shared `raceWithTimeout()` primitive
 * (reused, not reimplemented), and result-shape validation. A throw, a timeout, a failed shape
 * check, or a permanently-absent hook all map to the SAME degraded `{ outcome: 'unavailable' }`
 * result (AC3) — callers must never try to recover more detail than this from a non-'ok' result.
 */
export async function renderExtensionPanel(
  slot: string,
  knownSlots: readonly string[],
  logger: PanelLogger
): Promise<RenderExtensionPanelResult> {
  // AC3b: validated BEFORE the extension hook is ever invoked with a request-derived value — an
  // exact-match check against the one known slot is sufficient (and correct, per AC3b's own
  // scope discipline) since this story hardcodes exactly one valid slot.
  if (!knownSlots.includes(slot)) {
    return { outcome: 'invalid_slot' }
  }

  // AC3: re-checked fresh on every request, never cached from an earlier nav-render — the
  // extension can genuinely be gone by the time this route is hit.
  const status = getExtensionStatus()
  if (status.status !== 'loaded' || !status.hooks.uiPanel) {
    logUnavailable(logger, slot, 'not_loaded')
    return { outcome: 'unavailable' }
  }

  const uiPanel = status.hooks.uiPanel
  const raced = await raceWithTimeout(
    () => uiPanel.onRenderPanel({ slot }),
    RENDER_PANEL_TIMEOUT_MS
  )

  if (raced.status === 'timed_out') {
    logUnavailable(logger, slot, 'timed_out')
    return { outcome: 'unavailable' }
  }
  if (raced.status === 'rejected') {
    logUnavailable(logger, slot, 'threw')
    return { outcome: 'unavailable' }
  }

  // Minimal shape check — the extension's hook is trusted-but-arbitrary in-process code that
  // could return anything.
  if (typeof raced.value?.html !== 'string') {
    logUnavailable(logger, slot, 'malformed')
    return { outcome: 'unavailable' }
  }

  return { outcome: 'ok', html: raced.value.html }
}

/**
 * Story 25.1 AC5 — informational-only capability-declaration check (this codebase's existing
 * capability-negotiation convention, mirroring `apps/web/.../settings/extensions/+page.svelte`'s
 * own `declaresCapabilityGate`/`declaresAuditEventSource` reads): true iff an extension is
 * currently loaded AND its manifest declares the `'ui-panel'` capability. This is deliberately
 * NOT the same check as "will `onRenderPanel()` succeed right now" — a declared-but-transiently-
 * failing hook must still show the nav entry (AC3's degraded state is a per-request concern, not
 * a permanent-absence one); only a genuinely absent hook hides the nav entry (AC5).
 */
export function isUiPanelCapabilityDeclared(): boolean {
  const status = getExtensionStatus()
  return status.status === 'loaded' && status.manifest.capabilities.includes('ui-panel')
}
