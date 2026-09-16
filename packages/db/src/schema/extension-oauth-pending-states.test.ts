import { describe, expect, it } from 'vitest'
import { extensionOauthPendingStates } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('extension_oauth_pending_states schema (Story 39.1)', () => {
  it('exposes the start/callback pending-state columns', () => {
    expect(extensionOauthPendingStates.id).toBeDefined()
    expect(extensionOauthPendingStates.cookieHash).toBeDefined()
    expect(extensionOauthPendingStates.extensionName).toBeDefined()
    expect(extensionOauthPendingStates.stateJson).toBeDefined()
    expect(extensionOauthPendingStates.consumedAt).toBeDefined()
    expect(extensionOauthPendingStates.expiresAt).toBeDefined()
    expect(extensionOauthPendingStates.createdAt).toBeDefined()
  })

  it('documents extension_oauth_pending_states as an RLS coverage exception (org untrusted until callback)', () => {
    expect(EXCLUDED_TABLES.has('extension_oauth_pending_states')).toBe(true)
  })
})
