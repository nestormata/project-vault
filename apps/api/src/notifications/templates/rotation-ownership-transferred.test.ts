import { describe, expect, it } from 'vitest'
import { renderRotationOwnershipTransferred } from './rotation-ownership-transferred.js'
import { renderEmailTemplate } from './index.js'

const THREE_TITLE = '3 rotations were transferred to you'
const THREE_SUBJECT = `[Project Vault] ${THREE_TITLE}`

const PAYLOAD = {
  rotationCount: 3,
  rotationIds: ['rot-1', 'rot-2', 'rot-3'],
  fromUserId: 'user-previous',
  reason: 'deactivated',
}

describe('renderRotationOwnershipTransferred', () => {
  it('states the plural count and the previous-owner reason without leaking ids', () => {
    const result = renderRotationOwnershipTransferred(PAYLOAD)

    expect(result.subject).toBe(THREE_SUBJECT)
    expect(result.text).toContain(THREE_TITLE)
    expect(result.text).toContain('previous owner was deactivated or removed')
    expect(result.html).toContain(THREE_TITLE)
    for (const out of [result.text, result.html]) {
      expect(out).not.toContain('rot-1')
      expect(out).not.toContain('user-previous')
    }
  })

  it('uses singular wording for one rotation', () => {
    const result = renderRotationOwnershipTransferred({ ...PAYLOAD, rotationCount: 1 })

    expect(result.subject).toBe('[Project Vault] 1 rotation was transferred to you')
    expect(result.text).toContain('1 rotation was transferred to you')
  })

  it('falls back to neutral wording for a malformed count', () => {
    const result = renderRotationOwnershipTransferred({ rotationCount: 'x' })

    expect(result.subject).toBe('[Project Vault] Rotations were transferred to you')
    expect(result.text).not.toContain('undefined')
    expect(result.html).not.toContain('NaN')
  })

  it('is registered in the email dispatch table with inbox fields (not the generic fallback)', () => {
    const rendered = renderEmailTemplate('rotation.ownership_transferred', PAYLOAD)

    expect(rendered.subject).toBe(THREE_SUBJECT)
    expect(rendered.inboxTitle).toBe(THREE_TITLE)
    expect(rendered.inboxBody.length).toBeLessThanOrEqual(500)
    expect(rendered.text).not.toContain('Payload:')
  })
})
