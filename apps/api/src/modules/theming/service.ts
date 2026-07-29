import { promises as fsPromises } from 'node:fs'
import { extname, join } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import YAML from 'yaml'
import { AuditEvent, OperationalEvent, THEME_TOKENS } from '@project-vault/shared'
import type { ThemeTokenDefinition } from '@project-vault/shared'
import { operationalLog } from '../../lib/logger.js'
import { writeSystemAuditRow } from '../../lib/system-audit-row.js'
import { withOrg } from '@project-vault/db'
import { fetchAllOrgIds } from '../../middleware/rls.js'
import { resolveAndValidatePublicAddresses, type DnsLookupFn } from '../../lib/safe-fetch.js'

/**
 * Story 16.1 AC-10: hard cap on any single theme file's size, checked via fs.stat() before any
 * read is attempted. A theme file realistically needs a few KB; 256KB is generous headroom.
 */
export const MAX_THEME_FILE_BYTES = 256 * 1024
/** AC-10: bounds the `yaml` package's alias-expansion ("billion laughs") blast radius. */
export const MAX_YAML_ALIAS_COUNT = 100
const THEME_EXTENSIONS = new Set(['.json', '.yaml', '.yml'])

export type ThemeFailure = { file: string; reason: string }
export type ThemeReloadResult = { loaded: string[]; failed: ThemeFailure[] }
export type CompiledTheme = { name: string; file: string; css: string }

type LoggerLike = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>
type ReaddirFn = (dir: string) => Promise<string[]>
type StatFn = (filePath: string) => Promise<{ size: number }>
type ReadFileBoundedFn = (filePath: string, maxBytes: number) => Promise<string>
type ListOrgIdsFn = () => Promise<string[]>
type AuditWriterFn = (
  orgId: string,
  eventType: string,
  payload: Record<string, unknown>
) => Promise<void>

export type ThemeReloadDeps = {
  readdir?: ReaddirFn
  stat?: StatFn
  readFileBounded?: ReadFileBoundedFn
  dnsLookup?: DnsLookupFn
  logger?: LoggerLike
  listOrgIds?: ListOrgIdsFn
  auditWriter?: AuditWriterFn
}

const silentLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as LoggerLike

const defaultReaddir: ReaddirFn = (dir) => fsPromises.readdir(dir)
const defaultStat: StatFn = (filePath) => fsPromises.stat(filePath)

/**
 * AC-10 TOCTOU note: `fs.stat()` alone cannot be trusted as the size guarantee (the file can grow
 * between stat and read). This reads in bounded chunks and aborts the moment the actual byte
 * count crosses the cap, regardless of what stat() reported.
 */
const defaultReadFileBounded: ReadFileBoundedFn = async (filePath, maxBytes) => {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) {
        throw new Error(`file exceeds maximum size cap of ${maxBytes} bytes`)
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks).toString('utf-8')
  } finally {
    await handle.close()
  }
}

const defaultAuditWriter: AuditWriterFn = (orgId, eventType, payload) =>
  withOrg(orgId, (tx) => writeSystemAuditRow(tx, { orgId, eventType, payload }))

// AC-4: constrained color grammar — hex or a tightly-bounded rgb()/rgba()/hsl()/hsla() function
// form. No `url(`, no `;`, no `}`, no nesting — the exact breakout characters architecture.md
// names are structurally impossible to match this pattern.
const HEX_COLOR_GRAMMAR = /^#[0-9a-fA-F]{3,8}$/
const RGB_COLOR_GRAMMAR =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/
const HSL_COLOR_GRAMMAR =
  /^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/

function isValidColorGrammar(value: string): boolean {
  return (
    HEX_COLOR_GRAMMAR.test(value) || RGB_COLOR_GRAMMAR.test(value) || HSL_COLOR_GRAMMAR.test(value)
  )
}
// AC-4: strict numeric+unit pattern — rejects calc(), custom units, and any embedded expression.
const LENGTH_GRAMMAR = /^-?\d+(\.\d+)?(px|rem|em|%)$/
// AC-5/AC-4 crossover (found via adversarial code review): asset URLs are compiled into
// `--asset-x: url("<rawValue>");` by direct string interpolation, exactly like a `color` token's
// raw value would be if it weren't grammar-checked. Without an equivalent character-safety check
// here, a URL like `https://cdn.example/logo.svg") } input[type=password]{background:url("https://evil`
// is a syntactically valid URL (the WHATWG URL parser percent-encodes unsafe characters when
// resolving the hostname for the SSRF check, but the *raw, unencoded* string is what gets
// interpolated into the compiled CSS) that breaks out of the `url("...")` string and the
// declaration block — the exact CSS-injection/exfiltration technique AC-4 exists to prevent,
// just via the asset path instead of a color/length/enum token. Reject (never encode) any value
// containing a character that could terminate the CSS string or block, consistent with AC-4's
// "reject, don't sanitize" philosophy.
const ASSET_URL_UNSAFE_CHARS = /["'\\\s<>{}]/

let state: { themes: CompiledTheme[]; loadedCount: number; failedCount: number } = {
  themes: [],
  loadedCount: 0,
  failedCount: 0,
}

export function getThemesHealthField(): { themesLoaded: number; themesFailed: number } {
  return { themesLoaded: state.loadedCount, themesFailed: state.failedCount }
}

export function getCompiledThemes(): CompiledTheme[] {
  return state.themes
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetThemeStateForTests(): void {
  state = { themes: [], loadedCount: 0, failedCount: 0 }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** Converts a registry token key (e.g. `colorPrimary600`) into its CSS custom-property name
 * suffix (e.g. `color-primary-600`) — splits before every uppercase letter or digit run that
 * follows a lowercase letter. */
function kebabCase(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase()
}

type ThemeSchema = {
  name: string
  tokens: Record<string, unknown>
  assets: Record<string, unknown>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateThemeSchema(parsed: unknown): ThemeSchema | { reason: string } {
  if (!isPlainObject(parsed)) return { reason: 'theme definition must be an object' }
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    return { reason: 'missing required field `name`' }
  }
  const tokens = parsed.tokens ?? {}
  if (!isPlainObject(tokens)) return { reason: 'tokens must be an object' }
  const assets = parsed.assets ?? {}
  if (!isPlainObject(assets)) return { reason: 'assets must be an object' }
  return { name: parsed.name, tokens, assets }
}

const THEME_TOKEN_REGISTRY = THEME_TOKENS as Record<string, ThemeTokenDefinition>

function validateAndCompileTokens(
  tokens: Record<string, unknown>
): { declarations: string[] } | { reason: string } {
  const declarations: string[] = []
  for (const [key, rawValue] of Object.entries(tokens)) {
    const def = THEME_TOKEN_REGISTRY[key]
    if (!def) return { reason: `unregistered token \`${key}\`` }
    if (typeof rawValue !== 'string') return { reason: `token \`${key}\`: invalid value` }
    if (def.type === 'color' && !isValidColorGrammar(rawValue)) {
      return { reason: `token \`${key}\`: invalid color value` }
    }
    if (def.type === 'length' && !LENGTH_GRAMMAR.test(rawValue)) {
      return { reason: `token \`${key}\`: invalid length value` }
    }
    if (def.type === 'enum' && !def.values.includes(rawValue)) {
      return { reason: `token \`${key}\`: invalid value` }
    }
    declarations.push(`  --${kebabCase(key)}: ${rawValue};`)
  }
  return { declarations }
}

async function validateAssets(
  assets: Record<string, unknown>,
  dnsLookup: DnsLookupFn | undefined
): Promise<{ declarations: string[] } | { reason: string }> {
  const declarations: string[] = []
  for (const [key, rawValue] of Object.entries(assets)) {
    if (typeof rawValue !== 'string') return { reason: `asset '${key}': must be a URL string` }
    // AC-5 Dev Notes judgment call: HTTPS-only, for defense-in-depth consistency with the rest of
    // this codebase's outbound-URL conventions, even though the server never fetches it.
    if (!rawValue.startsWith('https://')) return { reason: `asset '${key}': must use https://` }
    if (ASSET_URL_UNSAFE_CHARS.test(rawValue)) {
      return { reason: `asset '${key}': URL contains unsafe characters` }
    }
    // Validated for well-formedness only — the raw string (not this parsed object) is what gets
    // interpolated into the compiled CSS below.
    try {
      new URL(rawValue)
    } catch {
      return { reason: `asset '${key}': not a valid URL` }
    }
    try {
      await resolveAndValidatePublicAddresses(rawValue, dnsLookup)
    } catch {
      return { reason: `asset '${key}': URL resolves to a private/reserved address` }
    }
    declarations.push(`  --asset-${kebabCase(key)}: url("${rawValue}");`)
  }
  return { declarations }
}

function compileThemeCss(name: string, declarations: string[]): string {
  return `[data-theme="${name}"] {\n${declarations.join('\n')}\n}`
}

function isAliasLimitError(error: unknown): boolean {
  return error instanceof Error && /alias count/i.test(error.message)
}

async function parseThemeContent(
  content: string,
  ext: string
): Promise<{ value: unknown } | { reason: string }> {
  try {
    const value =
      ext === '.json'
        ? JSON.parse(content)
        : YAML.parse(content, { maxAliasCount: MAX_YAML_ALIAS_COUNT })
    return { value }
  } catch (error) {
    if (isAliasLimitError(error)) return { reason: 'YAML alias expansion exceeds safe limit' }
    return { reason: 'not valid JSON/YAML' }
  }
}

function isReasonResult(value: unknown): value is { reason: string } {
  return Boolean(value) && typeof value === 'object' && 'reason' in (value as object)
}

async function processThemeFile(
  filePath: string,
  deps: { stat: StatFn; readFileBounded: ReadFileBoundedFn; dnsLookup?: DnsLookupFn }
): Promise<{ name: string; css: string } | { reason: string }> {
  let fileStat: { size: number }
  try {
    fileStat = await deps.stat(filePath)
  } catch {
    return { reason: 'unable to read file' }
  }
  if (fileStat.size > MAX_THEME_FILE_BYTES) {
    return { reason: `file exceeds maximum size (${MAX_THEME_FILE_BYTES / 1024}KB)` }
  }

  let content: string
  try {
    content = await deps.readFileBounded(filePath, MAX_THEME_FILE_BYTES)
  } catch {
    return { reason: `file exceeds maximum size (${MAX_THEME_FILE_BYTES / 1024}KB)` }
  }

  const ext = extname(filePath).toLowerCase()
  const parseResult = await parseThemeContent(content, ext)
  if (isReasonResult(parseResult)) return parseResult

  const schemaResult = validateThemeSchema(parseResult.value)
  if (isReasonResult(schemaResult)) return schemaResult

  const tokenResult = validateAndCompileTokens(schemaResult.tokens)
  if (isReasonResult(tokenResult)) return tokenResult

  const assetResult = await validateAssets(schemaResult.assets, deps.dnsLookup)
  if (isReasonResult(assetResult)) return assetResult

  const css = compileThemeCss(schemaResult.name, [
    ...tokenResult.declarations,
    ...assetResult.declarations,
  ])
  return { name: schemaResult.name, css }
}

function isThemeFile(fileName: string): boolean {
  return THEME_EXTENSIONS.has(extname(fileName).toLowerCase())
}

type ReloadOutcome = { result: ThemeReloadResult; directoryFound: boolean }

/**
 * Core reload logic shared by `reloadThemes()` and `reloadThemesWithFanout()`. `directoryFound`
 * additionally distinguishes "there was nothing to do" (themesDir unset, or ENOENT) from an
 * actual reload attempt — used by `reloadThemesWithFanout()` to decide whether the startup pass
 * has anything audit-worthy to report, mirroring `loadExtension()`'s own precedent of skipping
 * its audit fanout entirely when `VAULT_EXTENSIONS_PACKAGE` isn't configured, rather than writing
 * a `{ loadedCount: 0, failedCount: 0 }` row to every org's audit log on every single boot of a
 * self-hosted instance that has never configured a themes directory.
 */
/** Zero-behavior-change / directory-not-found result shape, shared by the "themesDir unset" and
 * "ENOENT" early-return branches. */
function absentDirectoryOutcome(): ReloadOutcome {
  state = { themes: [], loadedCount: 0, failedCount: 0 }
  return { result: { loaded: [], failed: [] }, directoryFound: false }
}

/** AC-2: lists `themesDir`, distinguishing "absent" (silent, expected) from "present but
 * unreadable" (operational-log-worthy misconfiguration) — both fold into the same
 * `absentDirectoryOutcome()` result shape, only the log output differs. Returns `null` on either
 * error path so the caller short-circuits; the sorted file list otherwise. */
async function listThemeFiles(
  themesDir: string,
  readdir: ReaddirFn,
  logger: LoggerLike
): Promise<string[] | null> {
  let entries: string[]
  try {
    entries = await readdir(themesDir)
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      operationalLog(
        logger,
        'fatal',
        OperationalEvent.THEME_DIRECTORY_UNREADABLE,
        'themes directory present but unreadable',
        { themesDir }
      )
    }
    return null
  }
  return entries.filter(isThemeFile).sort((a, b) => a.localeCompare(b))
}

async function processThemeFiles(
  themesDir: string,
  themeFiles: string[],
  deps: { stat: StatFn; readFileBounded: ReadFileBoundedFn; dnsLookup?: DnsLookupFn }
): Promise<{ loaded: string[]; failed: ThemeFailure[]; compiled: CompiledTheme[] }> {
  const loaded: string[] = []
  const failed: ThemeFailure[] = []
  const compiled: CompiledTheme[] = []
  const nameToFile = new Map<string, string>()

  for (const file of themeFiles) {
    const outcome = await processThemeFile(join(themesDir, file), deps)
    if (isReasonResult(outcome)) {
      failed.push({ file, reason: outcome.reason })
      continue
    }
    const existingFile = nameToFile.get(outcome.name)
    if (existingFile) {
      failed.push({
        file,
        reason: `duplicate theme name '${outcome.name}' (already loaded from ${existingFile})`,
      })
      continue
    }
    nameToFile.set(outcome.name, file)
    loaded.push(file)
    compiled.push({ name: outcome.name, file, css: outcome.css })
  }

  return { loaded, failed, compiled }
}

async function reloadThemesCore(
  themesDir: string | undefined,
  deps: ThemeReloadDeps
): Promise<ReloadOutcome> {
  const logger = deps.logger ?? silentLogger
  const readdir = deps.readdir ?? defaultReaddir
  const stat = deps.stat ?? defaultStat
  const readFileBounded = deps.readFileBounded ?? defaultReadFileBounded

  if (!themesDir) return absentDirectoryOutcome()

  const themeFiles = await listThemeFiles(themesDir, readdir, logger)
  if (themeFiles === null) return absentDirectoryOutcome()

  const { loaded, failed, compiled } = await processThemeFiles(themesDir, themeFiles, {
    stat,
    readFileBounded,
    dnsLookup: deps.dnsLookup,
  })

  state = { themes: compiled, loadedCount: loaded.length, failedCount: failed.length }

  operationalLog(
    logger,
    'info',
    OperationalEvent.THEME_RELOAD_SUMMARY,
    `${loaded.length} themes loaded, ${failed.length} failed`,
    {
      loadedCount: loaded.length,
      failedCount: failed.length,
      failedFiles: failed.map((f) => f.file),
    }
  )

  return { result: { loaded, failed }, directoryFound: true }
}

/**
 * Story 16.1: reads `themesDir`, validates and compiles every `.json`/`.yaml`/`.yml` file into a
 * `[data-theme]` CSS block, and never throws — a misconfigured or hostile theme directory can
 * never crash the caller (mirrors `loadExtension()`'s fail-safe philosophy). AC-2: an absent
 * directory is zero behavior change; a present-but-unreadable directory is an operational-log-
 * worthy misconfiguration, but both resolve to the same successful `{ loaded: [], failed: [] }`
 * shape.
 */
export async function reloadThemes(
  themesDir: string | undefined,
  deps: ThemeReloadDeps = {}
): Promise<ThemeReloadResult> {
  return (await reloadThemesCore(themesDir, deps)).result
}

/**
 * Dev Notes "audit fanout": mirrors `apps/api/src/extensions/loader.ts`'s `runAuditFanout()` for
 * the startup automatic reload pass, which has no single org / no authenticated caller. Per-org
 * write failures are logged and never crash boot.
 */
async function runThemeAuditFanout(
  payload: Record<string, unknown>,
  listOrgIds: ListOrgIdsFn,
  auditWriter: AuditWriterFn,
  logger: LoggerLike
): Promise<void> {
  let orgIds: string[]
  try {
    orgIds = await listOrgIds()
  } catch {
    operationalLog(
      logger,
      'fatal',
      OperationalEvent.THEME_AUDIT_FANOUT_ROW_FAILED,
      'theme audit fanout: failed to enumerate organizations',
      { subReason: 'org_enumeration_failed' }
    )
    return
  }

  for (const orgId of orgIds) {
    try {
      await auditWriter(orgId, AuditEvent.THEME_RELOADED, payload)
    } catch {
      operationalLog(
        logger,
        'fatal',
        OperationalEvent.THEME_AUDIT_FANOUT_ROW_FAILED,
        'theme audit fanout: per-org audit write failed',
        { orgId, subReason: 'audit_write_failed' }
      )
    }
  }
}

/**
 * Story 16.1 Task 5: startup automatic reload pass — reloads themes then fans the
 * `AuditEvent.THEME_RELOADED` write out to every existing org (no single org exists at boot).
 * Never throws.
 */
export async function reloadThemesWithFanout(
  themesDir: string | undefined,
  deps: ThemeReloadDeps = {}
): Promise<ThemeReloadResult> {
  const logger = deps.logger ?? silentLogger
  const { result, directoryFound } = await reloadThemesCore(themesDir, deps)
  if (directoryFound) {
    await runThemeAuditFanout(
      {
        loadedCount: result.loaded.length,
        failedCount: result.failed.length,
        failedFiles: result.failed.map((f) => f.file),
      },
      deps.listOrgIds ?? fetchAllOrgIds,
      deps.auditWriter ?? defaultAuditWriter,
      logger
    )
  }
  return result
}
