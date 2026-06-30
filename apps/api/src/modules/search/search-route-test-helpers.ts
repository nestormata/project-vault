import { expect } from 'vitest'

export function expectSearchResults<T extends { type: string; name: string }>(
  res: { statusCode: number; json(): { data: { results: T[] } } },
  matcher: (results: T[]) => boolean
): void {
  expect(res.statusCode).toBe(200)
  const body = res.json() as { data: { results: T[] } }
  expect(matcher(body.data.results)).toBe(true)
}
