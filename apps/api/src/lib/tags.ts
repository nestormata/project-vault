export function dedupeTags(tags: string[]): string[] {
  return tags.filter((tag, index) => tags.indexOf(tag) === index)
}

export function tagDelta(oldTags: string[], newTags: string[]) {
  return {
    added: newTags.filter((tag) => !oldTags.includes(tag)),
    removed: oldTags.filter((tag) => !newTags.includes(tag)),
  }
}
