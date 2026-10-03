import { parseLock, serializeLock } from './lock.js'

export interface PatchEntry {
  key: string
  kind: 'override' | 'replacement'
  newSha256: string
  hostVersion: string
}

/** Updates only the named entries' accepted hash and version in a lock's text. */
export function patchAcceptances(text: string, entries: readonly PatchEntry[]): string {
  const parsed = parseLock(text, 'composition.lock.json')
  if (parsed.lock === undefined) throw new Error(parsed.problem ?? 'invalid lock')
  const { lock } = parsed
  for (const entry of entries) {
    const list = entry.kind === 'override' ? lock.overrides : lock.replacements
    const found = list.find((item) => ('path' in item ? item.path : item.target) === entry.key)
    if (found !== undefined) {
      found.hostSha256 = entry.newSha256
      found.hostVersion = entry.hostVersion
    }
  }
  return serializeLock(lock)
}
