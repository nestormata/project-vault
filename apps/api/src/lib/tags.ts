export function normalizeTag(tag: string): string {
  return tag.toLowerCase()
}

export function dedupeTags(tags: string[]): string[] {
  const normalized = tags.map(normalizeTag)
  return normalized.filter((tag, index) => normalized.indexOf(tag) === index)
}

export function tagDelta(oldTags: string[], newTags: string[]) {
  return {
    added: newTags.filter((tag) => !oldTags.includes(tag)),
    removed: oldTags.filter((tag) => !newTags.includes(tag)),
  }
}
