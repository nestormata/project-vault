// Design section 9 and ADR 0007 decision 7: a pack's `messages` overlay overrides the values of
// PV's own message keys and adds locales PV lacks. CM's own strings are never merged.

const LANGUAGE = /^[A-Za-z]{2,3}$/
const SUBTAG = /^[A-Za-z0-9]{2,8}$/
const SCHEMA_KEY = '$schema'
const SETTINGS_FILE = 'project.inlang/settings.json'

export interface MessageOverlay {
  /** Pack-relative path, for messages. */
  file: string
  locale: string
  text: string
}

export interface MessagesInput {
  /** PV's catalogues by locale (file text). */
  host: ReadonlyMap<string, string>
  /** `project.inlang/settings.json` text. */
  settings: string
  overlays: readonly MessageOverlay[]
}

export interface MessagesResult {
  /** Composed path -> text, only for files that changed or were added. */
  files: Map<string, string>
  problems: string[]
  notes: string[]
}

type Catalogue = Map<string, unknown>

/** A BCP-47-shaped tag (`fr`, `pt-BR`, `zh-Hant-TW`): a language, then dash-separated subtags. */
function isLocaleTag(tag: string): boolean {
  const [language = '', ...subtags] = tag.split('-')
  return LANGUAGE.test(language) && subtags.every((subtag) => SUBTAG.test(subtag))
}

function parseCatalogue(text: string, label: string, problems: string[]): Catalogue | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return new Map(Object.entries(parsed))
    }
    problems.push(`${label}: must be a JSON object`)
  } catch (error) {
    problems.push(`${label}: malformed JSON (${(error as Error).message})`)
  }
  return null
}

function write(catalogue: Catalogue): string {
  return `${JSON.stringify(Object.fromEntries(catalogue), null, 2)}\n`
}

function applyOverlay(
  overlay: MessageOverlay,
  current: Catalogue | undefined,
  base: Catalogue,
  out: MessagesResult
): Catalogue | null {
  const incoming = parseCatalogue(overlay.text, overlay.file, out.problems)
  if (incoming === null) return null
  const next: Catalogue = new Map(current ?? [[SCHEMA_KEY, base.get(SCHEMA_KEY)]])
  for (const [key, value] of incoming) {
    if (key === SCHEMA_KEY) continue
    if (typeof value !== 'string') {
      out.problems.push(`${overlay.file}: the value of "${key}" must be a string`)
    } else if (base.has(key)) {
      next.set(key, value)
    } else {
      out.notes.push(`${overlay.file}: key "${key}" is not a PV message key and was not merged`)
    }
  }
  return next
}

/** The PV catalogue an overlay applies to: undefined for a locale PV lacks, null when unreadable. */
function currentCatalogue(
  overlay: MessageOverlay,
  host: ReadonlyMap<string, string>,
  problems: string[]
): Catalogue | null | undefined {
  const text = host.get(overlay.locale)
  return text === undefined
    ? undefined
    : parseCatalogue(text, `messages/${overlay.locale}.json`, problems)
}

function settingsLocales(settings: Catalogue): string[] {
  const locales = settings.get('locales')
  return Array.isArray(locales) ? (locales as string[]) : []
}

function applyOne(
  overlay: MessageOverlay,
  input: MessagesInput,
  base: Catalogue,
  out: MessagesResult
): boolean {
  if (!isLocaleTag(overlay.locale)) {
    out.problems.push(`${overlay.file}: "${overlay.locale}" is not a valid locale tag`)
    return false
  }
  const current = currentCatalogue(overlay, input.host, out.problems)
  const next = current === null ? null : applyOverlay(overlay, current, base, out)
  if (next === null) return false
  out.files.set(`messages/${overlay.locale}.json`, write(next))
  return true
}

/** Applies the overlays to PV's catalogues. Unknown keys are noted, never merged or refused. */
export function composeMessages(input: MessagesInput): MessagesResult {
  const out: MessagesResult = { files: new Map(), problems: [], notes: [] }
  const settings = parseCatalogue(input.settings, SETTINGS_FILE, out.problems)
  if (settings === null) return out
  const configured = settings.get('baseLocale')
  const baseName = typeof configured === 'string' ? configured : 'en'
  const base = parseCatalogue(
    input.host.get(baseName) ?? '{}',
    `messages/${baseName}.json`,
    out.problems
  )
  if (base === null) return out
  const locales = [...settingsLocales(settings)]
  for (const overlay of input.overlays) {
    if (applyOne(overlay, input, base, out) && !locales.includes(overlay.locale)) {
      locales.push(overlay.locale)
    }
  }
  if (locales.length !== settingsLocales(settings).length) {
    out.files.set(SETTINGS_FILE, write(new Map([...settings, ['locales', locales]])))
  }
  return out
}
