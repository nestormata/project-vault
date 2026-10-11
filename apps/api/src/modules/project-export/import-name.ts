import { sql } from 'drizzle-orm'
import type { SecureRouteContext } from '../../lib/secure-route.js'

/** `projects.name` is bounded 1..128 by the create-project schema; suffixed names must fit too. */
export const IMPORT_NAME_MAX_LENGTH = 128
/** Highest numbered suffix tried before giving up: names are not unique, so this is a soft bound. */
export const MAX_IMPORT_NAME_ATTEMPTS = 50

function importSuffix(attempt: number): string {
  return attempt === 1 ? ' (imported)' : ` (imported ${attempt})`
}

/**
 * Story 62-2 AC-5 / D4: the ordered candidate names for an import. Index 0 is the bare name,
 * index 1 is "{name} (imported)", then "(imported 2)", "(imported 3)", ... Every suffixed
 * candidate is cut to fit `IMPORT_NAME_MAX_LENGTH` (base truncated, then trimmed, then suffixed).
 * Pure string work: candidates are compared by the database with parameterized equality, never
 * turned into a LIKE/regex pattern (D4a).
 */
export function buildImportNameCandidates(baseName: string): string[] {
  const trimmed = baseName.trim()
  const candidates = [trimmed]
  for (let attempt = 1; attempt <= MAX_IMPORT_NAME_ATTEMPTS; attempt += 1) {
    const suffix = importSuffix(attempt)
    const base = trimmed.slice(0, IMPORT_NAME_MAX_LENGTH - suffix.length).trimEnd()
    candidates.push(`${base}${suffix}`)
  }
  return candidates
}

/** First candidate whose index is not taken; the last candidate when every one is taken. */
export function pickImportName(candidates: readonly string[], takenIndexes: ReadonlySet<number>) {
  const index = candidates.findIndex((_, i) => !takenIndexes.has(i))
  return candidates[index === -1 ? candidates.length - 1 : index] as string
}

/**
 * Resolve the stored name for an imported project. One parameterized query returns which
 * candidates already exist among the caller's non-archived projects (RLS scopes it to the org;
 * `lower(btrim())` is applied on both sides by the database so normalization always agrees).
 * The bundle name is hostile input: it only ever travels as a bound parameter, and nothing here
 * logs it.
 */
export async function resolveImportProjectName(
  secureCtx: SecureRouteContext,
  bundleName: string
): Promise<string> {
  const candidates = buildImportNameCandidates(bundleName)
  const candidateList = sql.join(
    candidates.map((candidate) => sql`${candidate}`),
    sql`, `
  )
  const rows = await secureCtx.tx.execute<{ idx: number }>(sql`
    SELECT (c.ord - 1)::int AS idx
    FROM unnest(ARRAY[${candidateList}]::text[]) WITH ORDINALITY AS c(name, ord)
    WHERE EXISTS (
      SELECT 1 FROM projects p
      WHERE p.archived_at IS NULL AND lower(btrim(p.name)) = lower(btrim(c.name))
    )
  `)
  const taken = new Set<number>(Array.from(rows, (row) => Number(row.idx)))
  // No collision keeps the bundle's own (untrimmed-as-supplied) name: regression guard.
  if (!taken.has(0)) return bundleName
  return pickImportName(candidates, taken)
}
