import { describe, expect, it } from 'vitest'
import { extensionRequestStates } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('extension_request_states schema (Story 40.1)', () => {
  it('exposes the peek/consume request-state columns, incl. org_id/identity_id (AC12)', () => {
    expect(extensionRequestStates.id).toBeDefined()
    expect(extensionRequestStates.cookieHash).toBeDefined()
    expect(extensionRequestStates.extensionName).toBeDefined()
    expect(extensionRequestStates.orgId).toBeDefined()
    expect(extensionRequestStates.identityId).toBeDefined()
    expect(extensionRequestStates.stateJson).toBeDefined()
    expect(extensionRequestStates.consumedAt).toBeDefined()
    expect(extensionRequestStates.expiresAt).toBeDefined()
    expect(extensionRequestStates.createdAt).toBeDefined()
  })

  it('documents extension_request_states as an RLS coverage exception (AC12 filters in application code instead)', () => {
    expect(EXCLUDED_TABLES.has('extension_request_states')).toBe(true)
  })
})
