// Story 68.10 AC-2.11 (Seed row, T): a seed step that hits a rate limit or a missing
// VAULT_ALLOW_REMOTE_INIT fails with the HTTP status and the route and is never retried silently.
import { describe, expect, it } from 'vitest'
import {
  type SeedPost,
  type SeedResponse,
  seedRegisterAndLogin,
} from '../apps/web/e2e/mechanism/seed-guard.js'

const reply = (status: number, body: unknown = {}): SeedResponse => ({
  status: () => status,
  ok: () => status >= 200 && status < 300,
  json: async () => body,
})

const options = { email: 'seed-user', password: 'pw', orgName: 'Org' }

describe('seedRegisterAndLogin', () => {
  it('registers, logs in and completes onboarding, in that order, once each', async () => {
    const calls: string[] = []
    const post: SeedPost = async (route) => {
      calls.push(route)
      return reply(200, { data: { userId: 'u1', orgId: 'o1' } })
    }
    await expect(seedRegisterAndLogin(post, options)).resolves.toEqual({
      userId: 'u1',
      orgId: 'o1',
    })
    expect(calls).toEqual([
      '/api/v1/auth/register',
      '/api/v1/auth/login',
      '/api/v1/users/me/onboarding',
    ])
  })

  it('fails with the status and the route of a 429 and never retries', async () => {
    const calls: string[] = []
    const post: SeedPost = async (route) => {
      calls.push(route)
      return reply(429, { code: 'rate_limited' })
    }
    await expect(seedRegisterAndLogin(post, options)).rejects.toThrow(
      'seed /api/v1/auth/register failed with HTTP 429'
    )
    expect(calls).toEqual(['/api/v1/auth/register'])
  })

  it('names the login route when only the login is limited', async () => {
    const post: SeedPost = async (route) =>
      route === '/api/v1/auth/login' ? reply(429) : reply(200)
    await expect(seedRegisterAndLogin(post, options)).rejects.toThrow(
      'seed /api/v1/auth/login failed with HTTP 429'
    )
  })
})
