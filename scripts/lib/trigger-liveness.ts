/**
 * Story 70.5 (epic-70 retro Finding 3): the pure text rules behind the stale-trigger check in
 * `check-deferred-work-triggers`. A revisit trigger that names only finished (`done`) stories can
 * never fire again, so an open entry whose every trigger clause is like that is rot. The rule is a
 * rot detector, not an adversarial barrier: any real anchor (a path, a backticked identifier, a
 * release / deploy / incident / observed event) keeps a clause alive, and a clause that cannot be
 * judged (unknown story key, no story key at all) is alive too.
 */
import { citedStoryKeys } from './story-keys.js'

/** The word `or` (either case, so `, OR ` too), `;` and `(1)` / `(2)` enumerators separate clauses. */
const CLAUSE_SPLIT = /\bor\b|;|\(\d{1,2}\)/i
// A bare `NN-NN[a-z]` token not joined to a word character, `.` or `-` (so `2026-10-05`, `3.32.0`
// and a longer `70-3-slug` are not read as a bare number).
const BARE_NUMBER = /(?<![\w.-])(\d{1,3}-\d{1,3}[a-z]?)(?![\w-]|\.\w)/g
// `story 70.3` / `stories 70.3`: the dotted form only counts right after the word story.
const DOTTED_NUMBER = /\bstor(?:y|ies)[ \t]+(\d{1,3})\.(\d{1,3}[a-z]?)(?![\w.])/gi
const BACKTICKED = /`[^`]+`/
const PATH_LIKE = /\w\/\w|\.(?:ts|tsx|js|md|ya?ml|sql|svelte|json|sh)\b/i
/** The closed list of non-story anchors: a clause naming one can still fire. */
const LIVE_WORDS = /\b(?:release|deploy|incident|observed)/i

export type StatusByKey = ReadonlyMap<string, string>

export function splitTriggerClauses(value: string): string[] {
  return value
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
}

type Refs = { keys: string[]; unresolved: boolean; stripped: string }

function keysForNumber(number: string, statuses: StatusByKey): string[] {
  return [...statuses.keys()].filter((key) => key.startsWith(`${number}-`))
}

function clauseRefs(clause: string, statuses: StatusByKey): Refs {
  const keys = new Set<string>()
  let unresolved = false
  let stripped = clause
  for (const slug of citedStoryKeys(clause)) {
    if (statuses.has(slug)) keys.add(slug)
    else unresolved = true
    stripped = stripped.replaceAll(slug, '')
  }
  const numbers = [
    ...[...stripped.matchAll(BARE_NUMBER)].map((m) => m[1] as string),
    ...[...stripped.matchAll(DOTTED_NUMBER)].map((m) => `${m[1]}-${m[2]}`),
  ]
  for (const number of numbers) {
    for (const key of keysForNumber(number, statuses)) keys.add(key)
  }
  stripped = stripped.replaceAll(BARE_NUMBER, '').replaceAll(DOTTED_NUMBER, '')
  return { keys: [...keys], unresolved, stripped }
}

/**
 * The finished story keys a clause depends on when the clause is dead (it names at least one
 * registered story, every one `done`, and it has no other anchor); `undefined` when it is alive.
 */
export function deadClauseKeys(clause: string, statuses: StatusByKey): string[] | undefined {
  const refs = clauseRefs(clause, statuses)
  if (refs.unresolved || refs.keys.length === 0) return undefined
  if (refs.keys.some((key) => statuses.get(key) !== 'done')) return undefined
  if (BACKTICKED.test(refs.stripped) || PATH_LIKE.test(refs.stripped)) return undefined
  if (LIVE_WORDS.test(refs.stripped)) return undefined
  return refs.keys
}

/**
 * The dead story keys of a whole trigger text, or `undefined` when any clause is alive (or there
 * is no clause at all).
 */
export function deadTriggerKeys(values: string[], statuses: StatusByKey): string[] | undefined {
  const clauses = values.flatMap(splitTriggerClauses)
  if (clauses.length === 0) return undefined
  const dead: string[] = []
  for (const clause of clauses) {
    const keys = deadClauseKeys(clause, statuses)
    if (keys === undefined) return undefined
    dead.push(...keys)
  }
  return [...new Set(dead)]
}
