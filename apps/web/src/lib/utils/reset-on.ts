/**
 * Story 68.1 AC-3: returns `value` unchanged. Inside a writable `$derived`, passing the record's
 * identity (e.g. the current credential id, itself a primitive `$derived`) makes the state depend
 * on that identity only: it resets to `value` when SvelteKit reuses the page for another record
 * (same route, new params), and otherwise keeps local updates across unrelated reloads.
 *
 * @example let revealedValue = $derived(resetOn<string | null>(credentialKey, null))
 */
export function resetOn<T>(identity: unknown, value: T): T {
  return value
}

/**
 * Story 68.1 AC-3: adds `item` unless an item with the same `id` is already present (a refresh
 * that landed while the create request was in flight may already contain it).
 */
export function withItem<T extends { id: string }>(
  items: readonly T[],
  item: T,
  position: 'start' | 'end'
): T[] {
  if (items.some((existing) => existing.id === item.id)) return [...items]
  return position === 'start' ? [item, ...items] : [...items, item]
}
