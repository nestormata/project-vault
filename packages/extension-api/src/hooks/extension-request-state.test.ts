import { describe, expect, it } from 'vitest'
import type { ExtensionRequestStateHostService } from './extension-request-state.js'

describe('ExtensionRequestStateHostService type (Story 40.1 AC3/AC4/AC12)', () => {
  it('consume() resolves the persisted state object', async () => {
    const host: ExtensionRequestStateHostService = {
      consume: () => Promise.resolve({ selectionId: 'abc123' }),
    }
    await expect(host.consume()).resolves.toEqual({ selectionId: 'abc123' })
  })

  it('consume() resolves undefined for every failure mode (AC4 generic collapse)', async () => {
    const host: ExtensionRequestStateHostService = {
      consume: () => Promise.resolve(undefined),
    }
    await expect(host.consume()).resolves.toBeUndefined()
  })

  it('consume() takes no parameters — it resolves the current request ambiently', () => {
    const host: ExtensionRequestStateHostService = {
      consume: () => Promise.resolve(undefined),
    }
    expect(host.consume.length).toBe(0)
  })
})
