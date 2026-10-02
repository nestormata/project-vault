import type { Contributions } from './lock.js'
import type { MaterializeResult, MaterializeRoot } from './materialize.js'
import { compareCodeUnits, normalizePackPath } from './paths.js'
import type { Pack } from './sources.js'
import type { UiPackManifest } from './types.js'

interface Reference {
  field: string
  path: string
  /** The manifest names it as server-only code. */
  server: boolean
}

function injectionReferences(manifest: UiPackManifest): Reference[] {
  return Object.entries(manifest.injections ?? {}).flatMap(([name, list]) =>
    list.flatMap((entry) => [
      { field: `injections.${name}.component`, path: entry.component, server: false },
      ...(entry.load === undefined
        ? []
        : [{ field: `injections.${name}.load`, path: entry.load, server: true }]),
      ...(entry.actions === undefined
        ? []
        : [{ field: `injections.${name}.actions`, path: entry.actions, server: true }]),
    ])
  )
}

/** Every file the manifest names (design section 3 step 4), with where it is declared. */
function manifestReferences(manifest: UiPackManifest): Reference[] {
  const replacements = Object.entries(manifest.replacements ?? {}).map(([target, entry]) => ({
    field: `replacements.${target}.with`,
    path: entry.with,
    server: target.startsWith('$lib/server/'),
  }))
  const hooks = Object.entries(manifest.hooks ?? {}).flatMap(([kind, path]) =>
    path === undefined ? [] : [{ field: `hooks.${kind}`, path, server: kind === 'server' }]
  )
  const single = (field: string, path: string | undefined): Reference[] =>
    path === undefined ? [] : [{ field, path, server: false }]
  return [
    ...injectionReferences(manifest),
    ...replacements,
    ...hooks,
    ...single('nav', manifest.nav),
    ...single('theme', manifest.theme),
  ]
}

/** The files to materialize under `$cm`, and a problem for each named file that is not in the pack. */
export function collectRoots(
  manifest: UiPackManifest,
  pack: Pack
): { roots: MaterializeRoot[]; problems: string[] } {
  const roots = new Map<string, MaterializeRoot>()
  const problems: string[] = []
  for (const ref of manifestReferences(manifest)) {
    const rel = normalizePackPath(ref.path)
    if (rel === null) {
      problems.push(`${ref.field}: "${ref.path}" must be a path inside the UI pack.`)
    } else if (!pack.files.has(rel)) {
      problems.push(`${ref.field}: ${ref.path} does not exist in the UI pack.`)
    } else {
      roots.set(rel, { rel, server: ref.server || roots.get(rel)?.server === true })
    }
  }
  return { roots: [...roots.values()], problems }
}

/** Where a manifest-named file landed in the composed tree, or null. */
export function composedPathOf(
  reference: string | undefined,
  mat: MaterializeResult
): string | null {
  if (reference === undefined) return null
  const rel = normalizePackPath(reference)
  if (rel === null) return null
  return mat.relocated.find((entry) => entry.source === rel)?.dest ?? rel
}

/** What the lock records for the contributions later stories apply (hooks, nav, theme, paths). */
export function contributionsOf(manifest: UiPackManifest, mat: MaterializeResult): Contributions {
  const hooks = Object.fromEntries(
    Object.entries(manifest.hooks ?? {}).flatMap(([kind, ref]) => {
      const where = composedPathOf(ref, mat)
      return where === null ? [] : [[kind, where]]
    })
  )
  const paths = manifest.protectedPaths
  return {
    hooks,
    nav: composedPathOf(manifest.nav, mat),
    theme: composedPathOf(manifest.theme, mat),
    protectedPaths:
      paths === undefined
        ? null
        : {
            add: [...(paths.add ?? [])].sort(compareCodeUnits),
            remove: [...(paths.remove ?? [])].sort(compareCodeUnits),
          },
  }
}

/** Contributions this story validates and records but does not apply (68-6, 68-7 own them). */
export function deferredNotes(manifest: UiPackManifest): string[] {
  const notes: string[] = []
  if (Object.keys(manifest.hooks ?? {}).length > 0) {
    notes.push(
      'hook composition not applied: requires web-host with composeHandles (Story 68-6); the hook files were materialized'
    )
  }
  if (manifest.nav !== undefined) {
    notes.push(
      'nav delta not applied: requires web-host with navigation as data (Story 68-7); the nav file was materialized'
    )
  }
  if (manifest.protectedPaths !== undefined) {
    notes.push('protectedPaths not applied: requires Story 68-6; recorded in the lock')
  }
  return notes
}
