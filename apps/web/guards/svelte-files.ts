// Story 68.10: the one `.svelte` file walker the shipped script guards share (form-guidance and
// monolithic-region), so the walk is written once. Never descends into node_modules; follows symlinks
// (a dangling one is skipped, not fatal); an unreadable root throws, so a guard cannot pass by scanning
// nothing. The same rules as the repository's own scan-utils walker, kept minimal because that one is
// not shipped. Imports only `node:` modules, so the compiled copy runs from a published package.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function walkSvelte(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) found.push(...walkSvelte(full))
    else if (stat.isFile() && full.endsWith('.svelte')) found.push(full)
  }
  return found
}
