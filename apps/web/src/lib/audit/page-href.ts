export function buildPageHref(
  filters: Record<string, string | undefined> | null | undefined
): (page: number) => string {
  return (targetPage: number): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value) params.set(key, value)
    }
    params.set('page', String(targetPage))
    return `?${params.toString()}`
  }
}
