/** Return the newest version section from an extension-api changelog. */
export function latestChangelogEntry(changelog: string): string | undefined {
  const lines = changelog.split('\n')
  const headingIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (line.startsWith('## ') && !line.startsWith('### ')) indexes.push(index)
    return indexes
  }, [])
  const start = headingIndexes[0]
  if (start === undefined) return undefined
  const end = headingIndexes[1] ?? lines.length
  return lines.slice(start, end).join('\n')
}
