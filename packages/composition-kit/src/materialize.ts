import { readFileSync } from 'node:fs'
import { extname, posix } from 'node:path'
import { sha256Hex } from './hash.js'
import { findCaseCollisions, isServerOnlyPath } from './paths.js'
import { applyEdits, scanSpecifiers, type Edit } from './rewrite.js'

export interface MaterializeRoot {
  /** Pack-relative path. */
  rel: string
  /** The manifest names it as server-only code (server hooks, injection load/actions, `$lib/server` replacements). */
  server: boolean
}

export interface MaterializeInput {
  packFiles: ReadonlyMap<string, string>
  roots: readonly MaterializeRoot[]
  /** Pack files overlaid in place (`src/...`, `static/...`): scanned for imports that escape `src/`. */
  overlayPaths: readonly string[]
  resolveFrom: string
}

export interface Relocated {
  dest: string
  source: string
  cmSha256: string
  server: boolean
}

export interface MaterializeResult {
  /** Composed path -> bytes, for every relocated file. */
  files: Map<string, Buffer>
  /** Composed path -> bytes, for overlay files whose imports had to be rewritten. */
  overlayEdits: Map<string, Buffer>
  relocated: Relocated[]
  /** Every pack file the closure reached (relocated or overlaid). */
  reached: Set<string>
  problems: string[]
  notes: string[]
}

const SCANNABLE = new Set(['.ts', '.mts', '.js', '.mjs', '.svelte', '.css'])
const RESOLVE_EXTENSIONS = ['.ts', '.js', '.svelte', '.mjs', '.css', '.json']
const CM_CLIENT = '$cm/'
const CM_SERVER = '$lib/server/_cm/'

function isOverlay(rel: string): boolean {
  return rel.startsWith('src/') || rel.startsWith('static/')
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../')
}

function splitSuffix(specifier: string): [string, string] {
  const at = specifier.search(/[?#]/)
  return at === -1 ? [specifier, ''] : [specifier.slice(0, at), specifier.slice(at)]
}

/** The pack file a spelled path names (`./x` may be `x.ts`, `x.svelte`, `x/index.ts`, and a
 * `./x.js` may be `x.ts`, the TypeScript spelling). */
function resolveInPack(spelled: string, files: ReadonlyMap<string, string>): string | undefined {
  const stem = spelled.replace(/\.(?:js|mjs)$/, '')
  const candidates = [
    spelled,
    ...RESOLVE_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${spelled}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => `${spelled}/index${extension}`),
  ]
  return candidates.find((candidate) => files.has(candidate))
}

function relativeSpecifier(fromDirectory: string, target: string): string {
  const relative = posix.relative(fromDirectory, target)
  return relative.startsWith('.') ? relative : `./${relative}`
}

class Materializer {
  readonly result: MaterializeResult = {
    files: new Map(),
    overlayEdits: new Map(),
    relocated: [],
    reached: new Set(),
    problems: [],
    notes: [],
  }
  private readonly serverRoots: ReadonlySet<string>
  private readonly queue: { rel: string; inPlace: boolean }[] = []
  private readonly relocatedRels = new Set<string>()

  constructor(private readonly input: MaterializeInput) {
    this.serverRoots = new Set(input.roots.filter((root) => root.server).map((root) => root.rel))
  }

  private isServer(rel: string): boolean {
    return this.serverRoots.has(rel) || isServerOnlyPath(rel)
  }

  destOf(rel: string): string {
    return `src/lib/${this.isServer(rel) ? 'server/' : ''}_cm/${rel}`
  }

  private enqueueRelocated(rel: string): void {
    if (this.relocatedRels.has(rel)) return
    this.relocatedRels.add(rel)
    this.queue.push({ rel, inPlace: false })
  }

  private specifierFor(spelled: string, resolved: string): string {
    return `${this.isServer(resolved) ? CM_SERVER : CM_CLIENT}${spelled}`
  }

  private rewriteSite(
    unitRel: string,
    inPlace: boolean,
    specifier: string,
    css: boolean
  ): { replacement: string } | { problem: string } | null {
    if (!isRelativeSpecifier(specifier)) return null
    const [path, suffix] = splitSuffix(specifier)
    const spelled = posix.normalize(posix.join(posix.dirname(unitRel), path))
    if (spelled === '..' || spelled.startsWith('../')) {
      return {
        problem: `Path escape: ${unitRel} imports "${specifier}", which is outside the UI pack.`,
      }
    }
    if (inPlace && isOverlay(spelled)) return null
    const resolved = resolveInPack(spelled, this.input.packFiles)
    if (resolved === undefined) {
      return {
        problem: `Unresolvable import: ${unitRel} imports "${specifier}", which does not exist in the UI pack.`,
      }
    }
    this.result.reached.add(resolved)
    if (!isOverlay(resolved)) this.enqueueRelocated(resolved)
    const next = css
      ? this.cssReference(unitRel, inPlace, spelled, resolved)
      : this.moduleSpecifier(unitRel, spelled, resolved)
    return { replacement: `${next}${suffix}` }
  }

  /** CSS gets a relative path (an alias in `url()` or `@import` is not reliably resolved). */
  private cssReference(
    unitRel: string,
    inPlace: boolean,
    spelled: string,
    resolved: string
  ): string {
    const target = isOverlay(resolved) ? spelled : this.destOf(resolved).replace(resolved, spelled)
    return relativeSpecifier(posix.dirname(inPlace ? unitRel : this.destOf(unitRel)), target)
  }

  /** `$lib/...` for a pack `src/lib` file, a relative path for other in-place files, else `$cm`. */
  private moduleSpecifier(unitRel: string, spelled: string, resolved: string): string {
    if (!isOverlay(resolved)) return this.specifierFor(spelled, resolved)
    if (spelled.startsWith('src/lib/')) return `$lib/${spelled.slice('src/lib/'.length)}`
    return relativeSpecifier(posix.dirname(this.destOf(unitRel)), spelled)
  }

  /** The file's bytes with every relative specifier rewritten (the same bytes when none changed). */
  private rewrittenBytes(unit: { rel: string; inPlace: boolean }, bytes: Buffer): Buffer {
    if (!SCANNABLE.has(extname(unit.rel))) return bytes
    const text = bytes.toString('utf8')
    const scan = scanSpecifiers(
      text,
      this.input.packFiles.get(unit.rel) ?? '',
      this.input.resolveFrom
    )
    for (const asset of scan.importMetaUrlAssets) {
      this.result.notes.push(
        `${unit.rel}: new URL("${asset}", import.meta.url) was left alone (a relocated file's asset reference cannot be rewritten safely)`
      )
    }
    const edits: Edit[] = []
    for (const site of scan.specifiers) {
      const change = this.rewriteSite(unit.rel, unit.inPlace, site.specifier, site.css === true)
      if (change !== null && 'problem' in change) this.result.problems.push(change.problem)
      else if (change !== null) edits.push({ ...site, replacement: change.replacement })
    }
    return edits.length > 0 ? Buffer.from(applyEdits(text, edits)) : bytes
  }

  private process(unit: { rel: string; inPlace: boolean }): void {
    const bytes = readFileSync(this.input.packFiles.get(unit.rel) ?? '')
    this.result.reached.add(unit.rel)
    const output = this.rewrittenBytes(unit, bytes)
    if (unit.inPlace) {
      if (output !== bytes) this.result.overlayEdits.set(unit.rel, output)
      return
    }
    const dest = this.destOf(unit.rel)
    this.result.files.set(dest, output)
    this.result.relocated.push({
      dest,
      source: unit.rel,
      cmSha256: sha256Hex(bytes),
      server: this.isServer(unit.rel),
    })
  }

  run(): MaterializeResult {
    for (const root of this.input.roots) {
      if (!this.input.packFiles.has(root.rel)) continue
      if (isOverlay(root.rel)) this.result.reached.add(root.rel)
      else this.enqueueRelocated(root.rel)
    }
    for (const rel of this.input.overlayPaths) this.queue.push({ rel, inPlace: true })
    for (let unit = this.queue.shift(); unit !== undefined; unit = this.queue.shift()) {
      this.process(unit)
    }
    for (const group of findCaseCollisions([...this.result.files.keys()])) {
      this.result.problems.push(`Case collision: ${group.join(' and ')} differ only by case.`)
    }
    this.result.relocated.sort((a, b) => (a.dest < b.dest ? -1 : 1))
    return this.result
  }
}

/** Design section 3 step 4: copies CM code that is not at a route path into `src/lib/_cm/**`
 * (`$cm`) or, when server-only, `src/lib/server/_cm/**`, rewriting relative imports (by AST) so
 * they keep resolving from the new location. */
export function materialize(input: MaterializeInput): MaterializeResult {
  return new Materializer(input).run()
}
