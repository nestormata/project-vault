import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { UIPanelContext } from '@project-vault/extension-api'
import { OperationalEvent, resolveAppliedThemeWithOrgDefault } from '@project-vault/shared'
import type { Tx } from '@project-vault/db'
import { organizations, users } from '@project-vault/db/schema'
import { getExtensionStatus } from '../extensions/loader.js'
import type { ExtensionState } from '../extensions/loader.js'
import { getCompiledThemes } from '../modules/theming/service.js'
import { callerCanSeeProject, logVisibilityDenied } from '../modules/projects/project-access.js'
import type { SecureRouteContext } from './secure-route.js'
import type { OrgRole } from '../plugins/require-org-role.js'
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
 * Story 25.12 AC2 — the legacy DATA-relay path allowlist, matching the exact pair
 * `+page.svelte`'s `ALLOWED_PANEL_DATA_PATH_PATTERNS` hardcoded before this story. This is now
 * the backward-compatible fallback used when a loaded extension's manifest omits
 * `panelDataPaths` — never mutated, never grown; `resolvePanelDataPaths` below is what derives
 * the real, extension-declared list.
 */
export const DEFAULT_PANEL_DATA_PATHS = ['/api/v1/projects', '/api/v1/projects/:id'] as const

/**
 * Story 25.12 AC2 — tracks the identity (`name:loadedAt`) of the extension load this module has
 * already warned about for the `panelDataPaths` fallback, mirroring
 * `lastFallbackWarnedLoadIdentity`'s own per-load, not per-request, warning discipline. A
 * separate variable from the `uiPanelSlots` one above — the two fallbacks are independent and
 * must not suppress each other's warning.
 */
let lastPanelDataPathsFallbackWarnedLoadIdentity: string | undefined

/** Test-only reset of this module's one-time-warning state — never called from production code. */
export function __resetPanelDataPathsFallbackWarningForTests(): void {
  lastPanelDataPathsFallbackWarnedLoadIdentity = undefined
}

function warnPanelDataPathsFallbackOnce(status: LoadedExtensionState, logger: PanelLogger): void {
  const loadIdentity = `${status.manifest.name}:${status.loadedAt}`
  if (lastPanelDataPathsFallbackWarnedLoadIdentity === loadIdentity) return
  lastPanelDataPathsFallbackWarnedLoadIdentity = loadIdentity
  // Story 25.12 AC2/Dependencies — reuses the SAME OperationalEvent enum value Story 25.2 AC2
  // established for its own manifest-fallback case (no new enum value introduced), only a second
  // call site with its own distinct message/metadata for this DATA-relay-specific fallback.
  operationalLog(
    logger,
    'warn',
    OperationalEvent.EXTENSION_UI_PANEL_SLOTS_FALLBACK,
    'Extension declares ui-panel without an explicit panelDataPaths list — running on the legacy project-only data-relay allowlist',
    { extensionName: status.manifest.name }
  )
}

/**
 * Story 25.12 AC2/Task 3 — derives the effective DATA-relay path allowlist for
 * `renderExtensionPanel()`'s `allowedDataPaths` response field, freshly on every call (never
 * memoized/cached at module scope — mirrors `resolveKnownUiPanelSlots`'s own freshness
 * discipline exactly, per Story 25.2 AC3's mid-process-reload finding).
 *
 * When no extension is loaded, or the loaded extension omits `panelDataPaths`, returns the exact
 * same fixed `DEFAULT_PANEL_DATA_PATHS` pair `+page.svelte` hardcoded before this story — zero
 * behavior change for any pre-25.12 extension package, with a one-time warn log on the fallback
 * path.
 */
export function resolvePanelDataPaths(
  status: ExtensionState | undefined,
  logger: PanelLogger
): readonly string[] {
  if (status?.status !== 'loaded') return DEFAULT_PANEL_DATA_PATHS

  const declared = status.manifest.panelDataPaths
  if (declared?.length) return declared

  warnPanelDataPathsFallbackOnce(status, logger)
  return DEFAULT_PANEL_DATA_PATHS
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
  if (status?.status !== 'loaded') return DEFAULT_UI_PANEL_SLOTS

  const declared = status.manifest.uiPanelSlots
  if (declared?.length) return declared

  warnUiPanelSlotsFallbackOnce(status, logger)
  return DEFAULT_UI_PANEL_SLOTS
}

/**
 * AC3: generous enough for a synchronous-shaped render call, short enough not to hang a page
 * load. Story 25.7 will formalize a project-wide timeout policy across all hook calls — this
 * story's own value is a reasonable interim default, not a final policy decision.
 */
const RENDER_PANEL_TIMEOUT_MS = 10_000

/**
 * Story 25.5 AC4/Task 4 — mirrors `resolveKnownUiPanelSlots`'s own pattern of reading the loaded
 * extension's manifest fresh on every request. `moduleActions` is a flat, extension-wide list
 * (not scoped per-slot in the manifest — see `manifest.ts`'s own field doc comment), so any
 * extension declaring at least one action gets an `actionEndpoint` for every valid `uiPanel`
 * slot it serves. Returns `undefined` (never `''`) when the extension declares no actions,
 * matching `UIPanelContext.actionEndpoint`'s own documented `undefined`-vs-`''` contract.
 */
function resolveActionEndpoint(
  status: ExtensionState | undefined,
  slot: string
): string | undefined {
  if (status?.status !== 'loaded') return undefined
  const declared = status.manifest.moduleActions
  if (!declared || declared.length === 0) return undefined
  return `/api/v1/extensions/panels/${slot}/actions`
}

export type RenderExtensionPanelResult =
  | { outcome: 'invalid_slot' }
  | { outcome: 'unavailable' }
  | {
      outcome: 'ok'
      html: string
      actionEndpoint: string | undefined
      /**
       * Story 25.12 AC2 — the resolved DATA-relay path allowlist (`resolvePanelDataPaths()`'s
       * result), always present (unlike `actionEndpoint`'s `undefined`-vs-omitted contract) —
       * at minimum the two-entry legacy `DEFAULT_PANEL_DATA_PATHS` default, never empty/nothing.
       */
      allowedDataPaths: string[]
    }

type PanelLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>

/**
 * Story 25.3 AC1 — the caller-identity subset `renderExtensionPanel()` needs to resolve the
 * request-scoped `UIPanelContext` fields. Deliberately narrower than the full `AuthContext`
 * (`request.authContext`) the route reads from `secureRoute()`: only `userId`/`orgId`/`orgRole`
 * are needed here, mirroring AC6's own least-privilege discipline one layer down from the
 * extension boundary itself.
 */
export type PanelIdentity = {
  userId: string
  orgId: string
  orgRole: OrgRole
}

/** Story 25.3 AC2/AC5 — the two optional, already shape-validated (Task 3's Zod querystring
 * schema) query values a panel request may carry. */
export type PanelQuery = {
  projectId?: string
  resourceId?: string
  /**
   * Story 25.8 AC1/Task 1 — the URL sub-path `apps/web`'s deep-linkable
   * `extensions/panels/[slot]/[...subpath]` route matched, forwarded on the SAME existing
   * `GET /api/v1/extensions/panels/:slot` call as a separate query field (never concatenated
   * into `:slot` itself — see this story's Dev Notes). Passed through verbatim with no PV-side
   * lookup or authorization, identical posture to `resourceId` above.
   */
  subpath?: string
}

/**
 * Story 25.3 Task 2 — every DB-touching dependency `renderExtensionPanel()` needs to resolve the
 * new context fields, injectable so this function's own unit tests can mock each one
 * independently (matching 25.1's own "reusable function, not inline in the route handler"
 * discipline) without standing up a real Postgres transaction.
 */
export type RenderExtensionPanelDeps = {
  /** AC2 — reused directly from `project-access.ts`, never reinvented. */
  callerCanSeeProject: (secureCtx: SecureRouteContext, projectId: string) => Promise<boolean>
  /** AC2 — reused directly from `project-access.ts`, never a new log format. */
  logVisibilityDenied: (
    req: { log: Pick<PanelLogger, 'warn'> },
    input: { projectId: string; callerId: string; orgRole: OrgRole }
  ) => void
  /** AC3 — `users.locale ?? 'en'`, mirroring `apps/api/src/modules/users/routes.ts`'s own
   * existing fallback. */
  getUserLocale: (tx: Tx, userId: string) => Promise<'en' | 'es'>
  /** AC4 — the three-tier `personal selection -> org default -> base` resolution, via the same
   * `resolveAppliedThemeWithOrgDefault()` apps/web calls (now shared via `@project-vault/shared`,
   * see Task 1). */
  resolveTheme: (tx: Tx, userId: string, orgId: string) => Promise<{ name: string | null }>
}

async function defaultGetUserLocale(tx: Tx, userId: string): Promise<'en' | 'es'> {
  const [row] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, userId))
  return (row?.locale ?? 'en') as 'en' | 'es'
}

async function defaultResolveTheme(
  tx: Tx,
  userId: string,
  orgId: string
): Promise<{ name: string | null }> {
  const [userRow] = await tx
    .select({ selectedThemeName: users.selectedThemeName })
    .from(users)
    .where(eq(users.id, userId))
  const [orgRow] = await tx
    .select({ defaultThemeName: organizations.defaultThemeName })
    .from(organizations)
    .where(eq(organizations.id, orgId))
  const availableThemeNames = getCompiledThemes().map((theme) => theme.name)
  const name = resolveAppliedThemeWithOrgDefault(
    userRow?.selectedThemeName ?? null,
    orgRow?.defaultThemeName ?? null,
    availableThemeNames
  )
  return { name }
}

/** Story 25.3 Task 2 — the real, production-wired dependency set; unit tests supply their own
 * mocked `RenderExtensionPanelDeps` instead of importing this. */
export const defaultRenderExtensionPanelDeps: RenderExtensionPanelDeps = {
  callerCanSeeProject,
  logVisibilityDenied,
  getUserLocale: defaultGetUserLocale,
  resolveTheme: defaultResolveTheme,
}

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
type PanelAttemptOutcome =
  { kind: 'denied'; projectId: string } | { kind: 'ok'; result: { html: unknown } }

/**
 * Story 25.3 Task 2 — the single unit of work `raceWithTimeout()` races: projectId
 * authorization, locale/theme resolution, and the hook call itself. Factored out of
 * `renderExtensionPanel()` purely to keep that function's own cyclomatic complexity within this
 * repo's lint budget — behaviorally this is still one atomic attempt, still wrapped in the same
 * timeout.
 */
export type BaseModuleActionContextOutcome =
  { kind: 'denied'; projectId: string } | { kind: 'ok'; context: UIPanelContext }

/**
 * Story 25.5 AC1/Task 5 — shared by `resolvePanelContextAndRender()` below (the `uiPanel` hook
 * call) and `module-action-handler.ts`'s equivalent attempt function (the `moduleAction.onAction`
 * call): the identical project-authorization gate (AC2/AC3) and locale/theme resolution, building
 * the identical `UIPanelContext`/`ModuleActionContext` shape (structurally the same type per
 * Story 25.5 AC1's deliberate re-exported alias). Extracted here so the two call sites can never
 * silently drift apart.
 */
export async function resolveBaseModuleActionContext(
  slot: string,
  identity: PanelIdentity,
  tx: Tx,
  query: PanelQuery,
  deps: RenderExtensionPanelDeps,
  actionEndpoint: string | undefined
): Promise<BaseModuleActionContextOutcome> {
  if (query.projectId !== undefined) {
    // AC2: PV-authorized via the existing project-visibility gate — reused, not reinvented.
    // Denial is reported via a distinct discriminant (not a thrown error) so it is not
    // conflated with a genuine hook/DB failure.
    const secureCtx = { auth: identity, tx } as SecureRouteContext
    const authorized = await deps.callerCanSeeProject(secureCtx, query.projectId)
    if (!authorized) {
      return { kind: 'denied', projectId: query.projectId }
    }
  }

  const locale = await deps.getUserLocale(tx, identity.userId)
  const theme = await deps.resolveTheme(tx, identity.userId, identity.orgId)

  const context: UIPanelContext = {
    slot,
    identity: { userId: identity.userId, orgRole: identity.orgRole },
    orgId: identity.orgId,
    locale,
    theme,
    // AC2/AC5: only included when the caller actually supplied the query value — omitting the
    // query parameter entirely means the field stays `undefined` in context, not every panel
    // request is project- or resource-scoped.
    ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
    // AC5: resourceId is passed through verbatim with NO PV-side lookup — see
    // `RenderExtensionPanelDeps` above, which has no resourceId-related dependency at all.
    ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
    // Story 25.8 AC1: subpath is passed through verbatim with NO PV-side lookup or
    // authorization, identical posture to resourceId above — purely apps/web-owned routing
    // state the extension may use to render its own internal sub-state.
    ...(query.subpath !== undefined ? { subpath: query.subpath } : {}),
    // Story 25.5 AC4/Task 4: only included when the loaded extension declares moduleActions —
    // `undefined` (never `''`), never present, when it does not.
    ...(actionEndpoint !== undefined ? { actionEndpoint } : {}),
  }
  return { kind: 'ok', context }
}

async function resolvePanelContextAndRender(
  slot: string,
  identity: PanelIdentity,
  tx: Tx,
  query: PanelQuery,
  deps: RenderExtensionPanelDeps,
  uiPanel: { onRenderPanel: (context: UIPanelContext) => Promise<{ html: unknown }> },
  actionEndpoint: string | undefined
): Promise<PanelAttemptOutcome> {
  const base = await resolveBaseModuleActionContext(slot, identity, tx, query, deps, actionEndpoint)
  if (base.kind === 'denied') return base
  const result = await uiPanel.onRenderPanel(base.context)
  return { kind: 'ok', result }
}

export async function renderExtensionPanel(
  slot: string,
  knownSlots: readonly string[],
  logger: PanelLogger,
  identity: PanelIdentity,
  tx: Tx,
  query: PanelQuery = {},
  deps: RenderExtensionPanelDeps = defaultRenderExtensionPanelDeps
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

  // AC1/AC3 Boundary & Edge Case Sweep: the projectId-authorization check, the locale/theme
  // lookups, AND the hook call itself are all wrapped in the SAME race-with-timeout attempt, so a
  // DB failure resolving any of the new context fields degrades to the identical
  // `panel_unavailable` outcome a hook throw/timeout already produces (Task 2) — never a raw 500.
  // `identity`/`orgId`/`locale`/`theme` are all read fresh from THIS call's own arguments only,
  // never from any module-level/shared state, so concurrent requests for different
  // users/orgs can never cross-contaminate (AC1's Boundary & Edge Case Sweep finding).
  const actionEndpoint = resolveActionEndpoint(status, slot)
  // Story 25.12 AC2/Task 3 — resolved fresh on every request, mirroring `knownSlots`' own
  // freshness discipline above; never cached from an earlier render.
  const allowedDataPaths = [...resolvePanelDataPaths(status, logger)]
  const raced = await raceWithTimeout(
    () => resolvePanelContextAndRender(slot, identity, tx, query, deps, uiPanel, actionEndpoint),
    RENDER_PANEL_TIMEOUT_MS
  )

  return finalizePanelResult(raced, logger, slot, identity, deps, actionEndpoint, allowedDataPaths)
}

/**
 * Story 25.3 Task 2 — turns the raced attempt's outcome into the final `RenderExtensionPanelResult`.
 * Factored out of `renderExtensionPanel()` to keep that function's cyclomatic complexity within
 * this repo's lint budget.
 */
function finalizePanelResult(
  raced: Awaited<ReturnType<typeof raceWithTimeout<PanelAttemptOutcome>>>,
  logger: PanelLogger,
  slot: string,
  identity: PanelIdentity,
  deps: RenderExtensionPanelDeps,
  actionEndpoint: string | undefined,
  allowedDataPaths: string[]
): RenderExtensionPanelResult {
  if (raced.status === 'timed_out') {
    logUnavailable(logger, slot, 'timed_out')
    return { outcome: 'unavailable' }
  }
  if (raced.status === 'rejected') {
    logUnavailable(logger, slot, 'threw')
    return { outcome: 'unavailable' }
  }

  const inner = raced.value
  if (inner.kind === 'denied') {
    // AC2 Red Team vs Blue Team: the SAME panel_unavailable outcome a transient hook failure
    // would produce — never a distinguishable 403/404 — so a caller enumerating project IDs
    // cannot tell "wrong project" apart from "extension is transiently down". The hook is never
    // invoked for a denied projectId.
    deps.logVisibilityDenied(
      { log: logger },
      { projectId: inner.projectId, callerId: identity.userId, orgRole: identity.orgRole }
    )
    return { outcome: 'unavailable' }
  }

  // Minimal shape check — the extension's hook is trusted-but-arbitrary in-process code that
  // could return anything.
  if (typeof inner.result?.html !== 'string') {
    logUnavailable(logger, slot, 'malformed')
    return { outcome: 'unavailable' }
  }

  return { outcome: 'ok', html: inner.result.html, actionEndpoint, allowedDataPaths }
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
