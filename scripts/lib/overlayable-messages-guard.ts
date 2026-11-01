// Story 72.19 (CentralizeMe request R4): the overlayable-message guard's library.
//
// A host overlays a PV message key in its pack (`messages/<locale>.json`). PV's shipped unit tests run
// over the composed tree, so a test that writes the key's default sentence turns that run red the day a
// host changes it. The keys are listed as data in `src/lib/i18n/overlayable-message-keys.ts`; this guard
// fails when
//   - a listed key is missing from one of PV's own locale files (the list and the catalog drifted);
//   - a unit test (`*.test.ts` under `src/`) contains a listed key's default text in any locale, raw or
//     as a regular-expression literal, instead of reading `m.<key>()` / `overlayableMessage(key)`;
//   - the mock UI pack stops overlaying a listed key with different text, because that pack is how the
//     composed run proves the rule (an overlay nobody makes proves nothing).
// Integrity only: no list of exempt files, no skip flag. An oracle that must keep the sentence masks it
// (`maskOverlayable`) and holds a token instead.
import { join } from 'node:path'
import { listNames, pathExists, readText } from './fs-access.js'
import { toRepoPath, walkFiles } from './scan-utils.js'

export const KEYS_FILE = 'src/lib/i18n/overlayable-message-keys.ts'
export const MESSAGES_DIR = 'messages'
export const MOCK_PACK_MESSAGES_DIR = 'fixtures/mock-ui-pack/ui-pack/messages'

export interface OverlayableMessagesResult {
  problems: string[]
  keys: number
  locales: number
  tests: number
}

type Catalog = ReadonlyMap<string, unknown>

interface DefaultText {
  key: string
  locale: string
  text: string
}

/** The quoted names in the `OVERLAYABLE_MESSAGE_KEYS` array literal, in order. */
export function readOverlayableKeys(webRoot: string): string[] | undefined {
  const file = join(webRoot, KEYS_FILE)
  if (!pathExists(file)) return undefined
  const array = /OVERLAYABLE_MESSAGE_KEYS\s*=\s*\[([^\]]*)\]/.exec(readText(file))
  if (array === null) return undefined
  return [...(array[1] ?? '').matchAll(/'([A-Za-z0-9_]+)'/g)].map((match) => match[1] ?? '')
}

/** Locale name -> catalog, for every `<locale>.json` in `dir`. */
function readCatalogs(dir: string): Map<string, Catalog> {
  const catalogs = new Map<string, Catalog>()
  if (!pathExists(dir)) return catalogs
  for (const name of listNames(dir).sort()) {
    if (!name.endsWith('.json')) continue
    const parsed = JSON.parse(readText(join(dir, name))) as Record<string, unknown>
    catalogs.set(name.slice(0, -'.json'.length), new Map(Object.entries(parsed)))
  }
  return catalogs
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The ways a test can write `text`: as is, or escaped the way a regular-expression literal needs. */
function spellings(text: string): string[] {
  return [...new Set([text, escapeRegExp(text)])]
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** PV's own default text of every listed key per locale, plus a problem for each one it lacks. */
function defaultTexts(
  keys: readonly string[],
  catalogs: ReadonlyMap<string, Catalog>
): { texts: DefaultText[]; problems: string[] } {
  const texts: DefaultText[] = []
  const problems: string[] = []
  for (const key of keys) {
    for (const [locale, catalog] of catalogs) {
      const text = nonEmptyText(catalog.get(key))
      if (text === undefined) {
        problems.push(`${MESSAGES_DIR}/${locale}.json has no text for the overlayable key ${key}`)
      } else {
        texts.push({ key, locale, text })
      }
    }
  }
  return { texts, problems }
}

function pinnedTextProblems(
  webRoot: string,
  tests: readonly string[],
  texts: readonly DefaultText[]
): string[] {
  return tests.flatMap((file) => {
    const source = readText(file)
    return texts
      .filter(({ text }) => spellings(text).some((spelling) => source.includes(spelling)))
      .map(
        ({ key, locale }) =>
          `${toRepoPath(webRoot, file)} writes the ${locale} text of the overlayable message ${key}; read it with overlayableMessage('${key}') or m.${key}() instead`
      )
  })
}

function mockPackProblems(
  keys: readonly string[],
  texts: readonly DefaultText[],
  pack: ReadonlyMap<string, Catalog>
): string[] {
  const pvTexts = new Set(texts.map(({ text }) => text))
  return keys
    .filter((key) =>
      [...pack.values()].every((catalog) => {
        const text = nonEmptyText(catalog.get(key))
        return text === undefined || pvTexts.has(text)
      })
    )
    .map(
      (key) =>
        `the mock UI pack (${MOCK_PACK_MESSAGES_DIR}) does not overlay ${key} with text of its own, so the composed run cannot prove it overlayable`
    )
}

export function checkOverlayableMessagesGuard(
  webRoot: string,
  mockPackMessagesDir: string = join(webRoot, '..', '..', MOCK_PACK_MESSAGES_DIR)
): OverlayableMessagesResult {
  const keys = readOverlayableKeys(webRoot)
  if (keys === undefined || keys.length === 0) {
    return {
      problems: [`${KEYS_FILE}: no OVERLAYABLE_MESSAGE_KEYS array literal with at least one key`],
      keys: 0,
      locales: 0,
      tests: 0,
    }
  }
  const catalogs = readCatalogs(join(webRoot, MESSAGES_DIR))
  const defaults = defaultTexts(keys, catalogs)
  const tests = walkFiles(join(webRoot, 'src'), (file) => file.endsWith('.test.ts'))
  return {
    problems: [
      ...defaults.problems,
      ...pinnedTextProblems(webRoot, tests, defaults.texts),
      ...mockPackProblems(keys, defaults.texts, readCatalogs(mockPackMessagesDir)),
    ],
    keys: keys.length,
    locales: catalogs.size,
    tests: tests.length,
  }
}
