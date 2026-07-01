import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isRedirect } from '@sveltejs/kit'
import { load } from './+page.server.js'

const routeRoot = resolve(dirname(fileURLToPath(import.meta.url)))

describe('/alerts route truth (AC-1)', () => {
  it('redirects authenticated GET /alerts to /notifications with a permanent redirect', async () => {
    let caught: unknown
    try {
      await load({ url: new URL('https://vault.example.com/alerts') } as Parameters<typeof load>[0])
    } catch (error) {
      caught = error
    }

    expect(isRedirect(caught)).toBe(true)
    const redirect = caught as { status: number; location: string }
    expect(redirect.status).toBe(308)
    expect(redirect.location.endsWith('/notifications')).toBe(true)
  })

  it('does not render a placeholder page for /alerts', () => {
    const placeholderPath = resolve(routeRoot, '+page.svelte')
    expect(existsSync(placeholderPath)).toBe(false)
  })
})
