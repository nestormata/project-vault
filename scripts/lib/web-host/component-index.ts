// Story 68.5 AC-9: the pack-time `manifests/component-index.json` of @project-vault/web-host.
//
// A registry of the UI modules a composed app may replace by resolved path (ADR 0007 M4), with a
// stability SIGNAL per module. It restricts nothing: any module under src/ can be replaced, stable
// or not (the kit only reports the signal in informational lock notes). Generated into the pack's
// staging directory on every pack, never committed, so a stale copy cannot exist.
//
// This is PV (AGPL) code and never imports the MIT composition kit. The hash is SHA-256 over the
// file's raw bytes, line endings untouched: byte-for-byte what the kit's drift check (`hostSha256`)
// computes, so a pack author can compare the two.
import { createHash } from 'node:crypto'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const COMPONENT_INDEX_VERSION = 1
export const STABLE_MARKER = '@pv-stable'

export type Stability = 'stable' | 'unmarked'

export interface ComponentIndexEntry {
  /** The composed-tree path (`src/lib/components/shell/GlobalSearch.svelte`). */
  path: string
  stability: Stability
  /** SHA-256 hex of the file's raw bytes. */
  hash: string
}

export interface ComponentIndex {
  schemaVersion: number
  components: ComponentIndexEntry[]
}

const LIB = 'src/lib/'
const COMPONENTS = 'src/lib/components/'
const TEST_FILE_RE = /\.(?:test|spec)\.(?:svelte\.)?[cm]?[jt]s$/
const TEST_SUPPORT_RE = /(?:^|\/)(?:__mocks__|__tests__|__fixtures__)\/|-test-helpers\.[cm]?[jt]s$/
const NOT_LIB_SOURCE = ['src/lib/test/', 'src/lib/paraglide/']

/** `.svelte` under `src/lib/components/`, `.ts` (including `.svelte.ts`) anywhere under `src/lib/`;
 * never a test, a test-support file, a declaration file or generated output. Routes are M1
 * overrides, not M4 replacements, and are not indexed. */
export function indexableFile(path: string): boolean {
  if (!path.startsWith(LIB)) return false
  if (NOT_LIB_SOURCE.some((prefix) => path.startsWith(prefix))) return false
  if (TEST_FILE_RE.test(path) || TEST_SUPPORT_RE.test(path) || path.endsWith('.d.ts')) return false
  if (path.endsWith('.svelte')) return path.startsWith(COMPONENTS)
  return path.endsWith('.ts')
}

function commentBody(text: string, open: string, close: string): string {
  const start = text.indexOf(open)
  if (start === -1) return ''
  const end = text.indexOf(close, start + open.length)
  return end === -1 ? '' : text.slice(start + open.length, end)
}

function hasMarker(comment: string): boolean {
  const at = comment.indexOf(STABLE_MARKER)
  if (at === -1) return false
  const after = comment.codePointAt(at + STABLE_MARKER.length)
  // A longer token (`@pv-stable-ish`) is not the marker.
  return after === undefined || !/[\w-]/.test(String.fromCodePoint(after))
}

/** Q5: stable when the file's FIRST top-level comment (the first `<!-- -->` of a `.svelte` file,
 * the first `/** *\/` of a `.ts` file) carries `@pv-stable`. Everything else is `unmarked`: PV makes
 * no promise either way. */
export function stabilityOf(path: string, text: string): Stability {
  const comment = path.endsWith('.svelte')
    ? commentBody(text, '<!--', '-->')
    : commentBody(text, '/**', '*/')
  return hasMarker(comment) ? 'stable' : 'unmarked'
}

export interface BuildOptions {
  /** Stage-relative paths to index (default: every indexable file under `<stage>/src/lib`). */
  files?: readonly string[]
}

function read(stageDir: string, path: string): Buffer {
  try {
    return readFileSync(join(stageDir, path))
  } catch {
    throw new Error(`component-index: cannot read ${path}`)
  }
}

/** Indexes the staged web-host tree. Throws (naming the path) for an unreadable file or a duplicate. */
export function buildComponentIndex(stageDir: string, options: BuildOptions = {}): ComponentIndex {
  const candidates =
    options.files ??
    globSync('src/lib/**/*', { cwd: stageDir }).map((rel) => rel.replaceAll('\\', '/'))
  const entries = new Map<string, ComponentIndexEntry>()
  for (const path of candidates.filter(indexableFile)) {
    if (entries.has(path)) throw new Error(`component-index: duplicate path ${path}`)
    const bytes = read(stageDir, path)
    entries.set(path, {
      path,
      stability: stabilityOf(path, bytes.toString('utf8')),
      hash: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const components = [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  return { schemaVersion: COMPONENT_INDEX_VERSION, components }
}

/** Deterministic text: two-space indent, trailing newline, no timestamps, no absolute paths. */
export function componentIndexText(index: ComponentIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`
}

/** Parses an index; null when the text is not one this generator wrote. */
export function readComponentIndex(text: string): ComponentIndex | null {
  try {
    const parsed = JSON.parse(text) as Partial<ComponentIndex>
    return parsed.schemaVersion === COMPONENT_INDEX_VERSION && Array.isArray(parsed.components)
      ? (parsed as ComponentIndex)
      : null
  } catch {
    return null
  }
}
