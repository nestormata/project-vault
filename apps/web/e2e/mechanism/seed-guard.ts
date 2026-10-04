// Story 68.10 AC-2.11: the seed step of the mechanism specs. It has no Playwright import so a unit
// test (scripts/mock-ui-pack-seed.test.ts) can drive it with a stub. A failed call stops the seed with
// the HTTP status and the route (never the response body, which may echo input) and is never retried:
// a blocked registration (a rate limit, VAULT_ALLOW_REMOTE_INIT missing) must be visible, not masked.

export interface SeedResponse {
  status(): number
  ok(): boolean
  json(): Promise<unknown>
}

export type SeedPost = (route: string, data: unknown) => Promise<SeedResponse>

export interface SeedOptions {
  email: string
  password: string
  orgName: string
}

async function checked(post: SeedPost, route: string, data: unknown): Promise<SeedResponse> {
  const response = await post(route, data)
  if (!response.ok()) throw new Error(`seed ${route} failed with HTTP ${response.status()}`)
  return response
}

/** Registers an org and owner, logs in (the caller's cookie jar keeps the session) and completes
 * onboarding, the same three calls as the shared `registerAndLoginViaApi`, each exactly once. */
export async function seedRegisterAndLogin(
  post: SeedPost,
  options: SeedOptions
): Promise<{ userId: string; orgId: string }> {
  await checked(post, '/api/v1/auth/register', {
    email: options.email,
    password: options.password,
    orgName: options.orgName,
  })
  const login = await checked(post, '/api/v1/auth/login', {
    email: options.email,
    password: options.password,
  })
  const body = (await login.json()) as { data: { userId: string; orgId: string } }
  await checked(post, '/api/v1/users/me/onboarding', { completed: true })
  return body.data
}
