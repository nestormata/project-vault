// Story 68.9 AC-2..AC-5, AC-12: the rules of PV's web guards as pure functions over
// `{ path, content }` files. The guard tests feed them the PV tree or a composed tree; a unit test
// feeds the same content under a PV path and under `src/lib/_cm/` and requires the same verdict.
// Nothing here is keyed on who wrote a file: every rule below is one PV already enforces on its own
// code, and a pack entry only ever adds or releases a reviewed exemption by exact path.
//
// This file is scanned by the guards like any other source file, so the tokens the rules look for
// are spelled in pieces (a literal one would make the scanner flag its own rule).
import {
  BASE_LOCAL_STORAGE_ENTRIES,
  BASE_SESSION_STORAGE_ENTRIES,
  type BaseStorageEntry,
} from './browser-storage-entries.js'
import {
  BASE_INTERNAL_API_CONSUMERS,
  INTERNAL_API_CHOKE_POINT,
} from '../server/internal-api-consumers.js'
import type { GuardEntries, StorageApi } from '../test/guard-root.js'

export interface GuardFile {
  /** App-relative, forward-slash. */
  path: string
  content: string
}

export type StorageKind = 'session' | 'local'

const KINDS: readonly StorageKind[] = ['session', 'local']
const apiOf = (kind: StorageKind): StorageApi => `${kind}Storage`
const INDEXED_DB = `indexed${'DB'}`
const RAW_HTML = `{${'@html'}`
const baseEntries = (kind: StorageKind): BaseStorageEntry[] =>
  kind === 'session' ? BASE_SESSION_STORAGE_ENTRIES : BASE_LOCAL_STORAGE_ENTRIES

/** `effective = base entries + pack additions - pack releases`, matched by exact path. */
export function effectiveStorageEntries(
  kind: StorageKind,
  entries: GuardEntries['browserStorage']
): BaseStorageEntry[] {
  const released = new Set(entries.release)
  return [
    ...baseEntries(kind).filter((entry) => !released.has(entry.file)),
    ...entries[apiOf(kind)],
  ]
}

export function effectiveInternalApiConsumers(
  entries: GuardEntries['internalApiConsumers']
): string[] {
  const released = new Set(entries.release)
  return [...BASE_INTERNAL_API_CONSUMERS.filter((file) => !released.has(file)), ...entries.add]
}

function snippet(kind: StorageKind, file: string, key: string): string {
  return (
    `browserStorage.${apiOf(kind)}: [{ file: '${file}', keys: ['${key}'], reason: '<why this is non-sensitive>' }] ` +
    '(entries are reviewed under PV rules; the alternative is to stop using browser storage in the file)'
  )
}

// One literal pattern per API. Written out whole, they do not match themselves: the letter before
// each name is a word character, so the leading word boundary fails on this very source text.
const USES = { session: /\bsessionStorage\b/, local: /\blocalStorage\b/ }
const KEY_CALLS = {
  session: /\bsessionStorage\??\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]*)['"]/g,
  local: /\blocalStorage\??\.(?:getItem|setItem|removeItem)\(\s*['"]([^'"]*)['"]/g,
}

function usesApi(kind: StorageKind, content: string): boolean {
  return (kind === 'session' ? USES.session : USES.local).test(content)
}

function literalKeys(kind: StorageKind, content: string): string[] {
  const calls = kind === 'session' ? KEY_CALLS.session : KEY_CALLS.local
  return [...content.matchAll(calls)].map((match) => match[1] ?? '')
}

function fileProblems(
  kind: StorageKind,
  file: GuardFile,
  entry: BaseStorageEntry | undefined
): string[] {
  if (!usesApi(kind, file.content)) return []
  if (entry === undefined) {
    return [
      `${file.path} uses ${apiOf(kind)} and no guard entry names it. Fix: ${snippet(kind, file.path, '<key>')}`,
    ]
  }
  return literalKeys(kind, file.content)
    .filter((key) => !entry.keys.includes(key))
    .map(
      (key) =>
        `${file.path} uses ${apiOf(kind)} key '${key}', which its entry does not declare. Fix: ${snippet(kind, file.path, key)}`
    )
}

function staleEntryProblems(
  kind: StorageKind,
  entries: readonly BaseStorageEntry[],
  files: ReadonlyMap<string, GuardFile>,
  removed: ReadonlySet<string>
): string[] {
  return entries.flatMap((entry) => {
    const file = files.get(entry.file)
    if (file === undefined) {
      return removed.has(entry.file)
        ? []
        : [
            `${apiOf(kind)} entry ${entry.file} names no file in the tree and the lock records no removal (stale carve-out)`,
          ]
    }
    return usesApi(kind, file.content)
      ? []
      : [
          `${apiOf(kind)} entry ${entry.file} is stale: the file no longer references ${apiOf(kind)}; release it with browserStorage.release`,
        ]
  })
}

/** Browser-storage use outside the reviewed entries, key mismatches and stale entries. */
export function storageViolations(
  files: readonly GuardFile[],
  entries: GuardEntries['browserStorage'],
  removed: ReadonlySet<string> = new Set()
): string[] {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const problems = KINDS.flatMap((kind) => {
    const effective = effectiveStorageEntries(kind, entries)
    const entryOf = new Map(effective.map((entry) => [entry.file, entry]))
    return [
      ...files.flatMap((file) => fileProblems(kind, file, entryOf.get(file.path))),
      ...staleEntryProblems(kind, effective, byPath, removed),
    ]
  })
  const indexed = files
    .filter((file) => file.content.includes(INDEXED_DB))
    .map((file) => `${file.path} uses ${INDEXED_DB} (no entry kind exists for it)`)
  return [...problems, ...indexed]
}

export function rawHtmlViolations(files: readonly GuardFile[]): string[] {
  return files
    .filter((file) => file.content.includes(RAW_HTML))
    .map((file) => `${file.path} uses raw HTML rendering`)
}

// The global fetch used as a value, not the `typeof` type annotation many load functions use for
// SvelteKit's own `event.fetch`.
const FETCH_VALUE = /(?<!typeof\s)\bglobalThis\.fetch\b/
const API_BASE = `API_BASE${'_URL'}`

/** Modules that pair the internal API base URL with a raw global fetch (the choke point is exempt). */
export function chokePointOffenders(files: readonly GuardFile[]): string[] {
  return files
    .filter((file) => file.path !== INTERNAL_API_CHOKE_POINT)
    .filter((file) => file.content.includes(API_BASE) && FETCH_VALUE.test(file.content))
    .map((file) => file.path)
}

/** The anti-vacuous check: the scan must see every expected API base URL consumer. This is an
 * expectation about the scan, not a rule on CM; a pack that changed a named consumer releases it. */
export function consumerViolations(
  files: readonly GuardFile[],
  entries: GuardEntries['internalApiConsumers'],
  removed: ReadonlySet<string> = new Set()
): string[] {
  const readers = new Set(
    files.filter((file) => file.content.includes(API_BASE)).map((file) => file.path)
  )
  return effectiveInternalApiConsumers(entries)
    .filter((expected) => !readers.has(expected) && !removed.has(expected))
    .map(
      (expected) =>
        `expected ${API_BASE} consumer ${expected} was not found (anti-vacuous check, not a rule on your code). ` +
        `If the file was changed on purpose, add internalApiConsumers.release: ['${expected}']`
    )
}
