/** Minimal cookie-jar helpers, reimplemented locally rather than importing apps/api's
 * test-only `__tests__/helpers/*` files (those are not part of `@project-vault/api`'s public
 * package surface — D6 point 3(c) explicitly calls for this package to bootstrap its own fixture
 * data via real `app.inject()` calls, not by reaching into a sibling package's private test
 * internals). */
export type CookieJar = Record<string, string>

export function parseSetCookies(setCookie: string | string[] | undefined): CookieJar {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return Object.fromEntries(
    headers
      .map((header) => header.split(';')[0] ?? '')
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...valueParts] = cookie.split('=')
        return [name, valueParts.join('=')]
      })
  )
}

export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/** `FastifyInjectResponse` (apps/api's own inject-response type) only exposes `.json<T>()`, not
 * a raw body/payload string — this safely stringifies a response body for error messages
 * without risking a second exception if the body isn't valid JSON. */
export function describeResponse(res: { statusCode: number; json<T>(): T }): string {
  try {
    return `${res.statusCode} ${JSON.stringify(res.json())}`
  } catch {
    return `${res.statusCode} (non-JSON body)`
  }
}
