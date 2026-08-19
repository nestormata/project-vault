/** Return the newest version section from an extension-api changelog. */
export function latestChangelogEntry(changelog: string): string | undefined {
  const headings = [...changelog.matchAll(/^##\s+.+$/gm)].map((match) => match.index ?? 0)
  const start = headings[0]
  if (start === undefined) return undefined
  return changelog.slice(start, headings[1] ?? changelog.length)
}
