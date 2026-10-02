import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Story 68.2 AC-5: Paraglide's message-format plugin is a committed, byte-pinned file, so
// `paraglide compile` is offline and reproducible, for PV and for every web-host consumer. Before
// 68.2, project.inlang/settings.json fetched `@inlang/plugin-message-format@latest` from a CDN on
// every compile, and an offline compile silently produced no messages. The plugin lives in
// apps/web/inlang-plugins/, NOT inside project.inlang/: inlang writes its own `*` / `!settings.json`
// .gitignore into project.inlang on every compile, which would silently untrack anything else there.
// Rules:
//   (a) no `modules` entry is an http(s) URL or names `@latest`;
//   (b) every `modules` entry is pinned in apps/web/inlang-plugins/plugins.lock.json, and the
//       file's sha256 equals the pin.
// To upgrade the plugin: `npm pack @inlang/plugin-message-format@<version>`, copy the tarball's
// `dist/index.js` over apps/web/inlang-plugins/plugin-message-format.js.txt, then update
// plugins.lock.json (version + `sha256sum` of the file) and the plugins README in the same commit.

const repositoryRoot = join(import.meta.dirname, '..')
const PINNED_ENTRY = './inlang-plugins/plugin-message-format.js.txt'

const REGENERATE_HINT =
  'Fix: vendor the plugin file and update apps/web/inlang-plugins/plugins.lock.json ' +
  '(steps at the top of scripts/check-paraglide-plugin-pinned.test.ts).'

export interface PluginPin {
  package: string
  version: string
  sha256: string
}

export interface InlangSettings {
  modules?: string[]
}

function checkModule(
  entry: string,
  pins: ReadonlyMap<string, PluginPin>,
  fileSha256: (moduleEntry: string) => string | undefined
): string | undefined {
  if (/^https?:\/\//i.test(entry) || entry.includes('@latest')) {
    return `${entry}: a module must be a committed local file, never a URL or @latest. ${REGENERATE_HINT}`
  }
  const pin = pins.get(entry)
  if (pin === undefined) return `${entry}: not pinned in plugins.lock.json. ${REGENERATE_HINT}`
  const actual = fileSha256(entry)
  if (actual === pin.sha256) return undefined
  return (
    `${entry}: sha256 ${actual ?? '(file missing)'} does not match the pinned ${pin.sha256} ` +
    `(${pin.package} ${pin.version}). ${REGENERATE_HINT}`
  )
}

/** Returns one message per rule violation; `fileSha256` maps a module entry to its file's hash. */
export function findPluginPinViolations(
  settings: InlangSettings,
  pins: ReadonlyMap<string, PluginPin>,
  fileSha256: (moduleEntry: string) => string | undefined
): string[] {
  const modules = settings.modules ?? []
  if (modules.length === 0) {
    return ['settings.json has no `modules`: the message-format plugin is missing']
  }
  return modules.flatMap((entry) => checkModule(entry, pins, fileSha256) ?? [])
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

// The only plugin file this repo vendors, read by a literal path; undefined when it is missing.
function repoFileSha256(entry: string): string | undefined {
  if (entry !== PINNED_ENTRY) return undefined
  try {
    return sha256(
      readFileSync(join(repositoryRoot, 'apps/web/inlang-plugins/plugin-message-format.js.txt'))
    )
  } catch {
    return undefined
  }
}

const WEB_DIR = join(repositoryRoot, 'apps/web')
const loadSettings = (): InlangSettings =>
  JSON.parse(readFileSync(join(WEB_DIR, 'project.inlang/settings.json'), 'utf8')) as InlangSettings
const loadPins = (): Map<string, PluginPin> =>
  new Map(
    Object.entries(
      JSON.parse(readFileSync(join(WEB_DIR, 'inlang-plugins/plugins.lock.json'), 'utf8')) as Record<
        string,
        PluginPin
      >
    )
  )

// Synthetic pins for the self-tests: any 64-hex string is a well-formed sha256.
const FAKE_SHA = 'ab'.repeat(32)
const fakePins = new Map([
  [PINNED_ENTRY, { package: 'plugin', version: '1.0.0', sha256: FAKE_SHA }],
])
const matching = (): string => FAKE_SHA

describe('check-paraglide-plugin-pinned: rule self-tests (Story 68.2 AC-5)', () => {
  it('fails on the pre-68.2 CDN @latest module', () => {
    const violations = findPluginPinViolations(
      {
        modules: [
          'https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@latest/dist/index.js',
        ],
      },
      fakePins,
      matching
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/never a URL or @latest/)
  })

  it('fails on an exact-version CDN URL too (still a network fetch)', () => {
    const cdn = 'https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4.4.4/dist/index.js'
    expect(findPluginPinViolations({ modules: [cdn] }, fakePins, matching)).toHaveLength(1)
  })

  it('fails when the vendored file no longer matches its pin, naming the regenerate step', () => {
    const violations = findPluginPinViolations({ modules: [PINNED_ENTRY] }, fakePins, () =>
      'cd'.repeat(32)
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('does not match the pinned')
    expect(violations[0]).toContain('plugins.lock.json')
  })

  it('fails on an unpinned local module and on a missing file', () => {
    expect(
      findPluginPinViolations({ modules: ['./plugins/other.js'] }, fakePins, matching)
    ).toHaveLength(1)
    const missing = findPluginPinViolations({ modules: [PINNED_ENTRY] }, fakePins, () => undefined)
    expect(missing[0]).toContain('(file missing)')
  })

  it('fails when modules is empty (no plugin means no messages)', () => {
    expect(findPluginPinViolations({ modules: [] }, fakePins, matching)).toHaveLength(1)
  })

  it('passes the pinned local file with a matching hash', () => {
    expect(findPluginPinViolations({ modules: [PINNED_ENTRY] }, fakePins, matching)).toEqual([])
  })
})

describe('check-paraglide-plugin-pinned: this repo (Story 68.2 AC-5)', () => {
  it('loads the plugin only from the committed, hash-pinned file', () => {
    const pins = loadPins()
    expect(pins.get(PINNED_ENTRY)?.package).toBe('@inlang/plugin-message-format')
    expect(findPluginPinViolations(loadSettings(), pins, repoFileSha256)).toEqual([])
  })
})
