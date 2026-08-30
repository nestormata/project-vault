import { describe, expect, it } from 'vitest'
import {
  renderSecurityFailedAuthThreshold,
  renderSecurityFailedAuthThresholdSlack,
} from './security-failed-auth-threshold.js'

const IP_PAYLOAD = {
  thresholdType: 'ip' as const,
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 12,
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-01T00:05:00.000Z',
  ipAddress: '203.0.113.1',
}

const ACCOUNT_PAYLOAD = {
  thresholdType: 'account' as const,
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 12,
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-01T00:05:00.000Z',
  userId: 'user-123',
}

describe('renderSecurityFailedAuthThreshold', () => {
  it('describes an IP-scoped threshold breach by address', () => {
    const result = renderSecurityFailedAuthThreshold(IP_PAYLOAD)
    expect(result.text).toContain('IP address 203.0.113.1')
    expect(result.text).toContain('Attempts: 12 in 5 minutes')
    expect(result.html).toContain('IP address 203.0.113.1')
  })

  it('describes an account-scoped threshold breach by userId', () => {
    const result = renderSecurityFailedAuthThreshold(ACCOUNT_PAYLOAD)
    expect(result.text).toContain('user account user-123')
    expect(result.html).toContain('user account user-123')
  })

  it('falls back to "unknown" when ipAddress/userId is absent', () => {
    const { ipAddress: _ip, ...withoutIp } = IP_PAYLOAD
    expect(renderSecurityFailedAuthThreshold(withoutIp).text).toContain('IP address unknown')

    const { userId: _uid, ...withoutUserId } = ACCOUNT_PAYLOAD
    expect(renderSecurityFailedAuthThreshold(withoutUserId).text).toContain('user account unknown')
  })

  it('HTML-escapes the window timestamps', () => {
    const result = renderSecurityFailedAuthThreshold({
      ...IP_PAYLOAD,
      windowStart: '<script>1</script>',
    })
    expect(result.html).not.toContain('<script>1</script>')
    expect(result.html).toContain('&lt;script&gt;1&lt;/script&gt;')
  })

  // Story 28.6 AC1 — windowStart/windowEnd/windowSeconds lacked the same `?? 'unknown'`
  // defensive fallback already applied to ipAddress/userId, causing escapeHtml(undefined) to
  // throw and crash-loop notification delivery. These assert the fix without throwing.
  it('falls back to "unknown" when windowStart is missing', () => {
    const { windowStart: _ws, ...withoutWindowStart } = IP_PAYLOAD
    expect(() => renderSecurityFailedAuthThreshold(withoutWindowStart)).not.toThrow()
    const result = renderSecurityFailedAuthThreshold(withoutWindowStart)
    expect(result.text).toContain('unknown')
    expect(result.html).toContain('unknown')
  })

  it('falls back to "unknown" when windowEnd is missing', () => {
    const { windowEnd: _we, ...withoutWindowEnd } = IP_PAYLOAD
    expect(() => renderSecurityFailedAuthThreshold(withoutWindowEnd)).not.toThrow()
    const result = renderSecurityFailedAuthThreshold(withoutWindowEnd)
    expect(result.text).toContain('unknown')
    expect(result.html).toContain('unknown')
  })

  it('falls back to "unknown" when windowStart/windowEnd are null', () => {
    const result = renderSecurityFailedAuthThreshold({
      ...IP_PAYLOAD,
      windowStart: null,
      windowEnd: null,
    })
    expect(result.text).toContain('unknown')
    expect(result.html).toContain('unknown')
  })

  it('falls back to "unknown" when windowStart/windowEnd are the wrong type (number)', () => {
    const result = renderSecurityFailedAuthThreshold({
      ...IP_PAYLOAD,
      windowStart: 12345,
      windowEnd: 67890,
    })
    expect(() => result).not.toThrow()
    expect(result.text).toContain('unknown')
    expect(result.html).toContain('unknown')
  })

  it('does not produce NaN when windowSeconds is missing/malformed', () => {
    const { windowSeconds: _ws, ...withoutWindowSeconds } = IP_PAYLOAD
    const result = renderSecurityFailedAuthThreshold(withoutWindowSeconds)
    expect(result.text).not.toContain('NaN')
    expect(result.html).not.toContain('NaN')

    const malformed = renderSecurityFailedAuthThreshold({
      ...IP_PAYLOAD,
      windowSeconds: 'not-a-number',
    })
    expect(malformed.text).not.toContain('NaN')
    expect(malformed.html).not.toContain('NaN')
  })

  it('renders successfully for the literal {} payload (notification_queue.payload column default)', () => {
    expect(() => renderSecurityFailedAuthThreshold({})).not.toThrow()
    const result = renderSecurityFailedAuthThreshold({})
    expect(result.subject).toBeTruthy()
    expect(result.text).not.toContain('NaN')
    expect(result.html).not.toContain('NaN')
    expect(result.text).toContain('unknown')
  })
})

describe('renderSecurityFailedAuthThresholdSlack', () => {
  it('describes an IP-scoped breach in Slack mrkdwn', () => {
    const result = renderSecurityFailedAuthThresholdSlack(IP_PAYLOAD)
    expect(result.text).toContain('Failed login threshold exceeded')
    const section = result.blocks[1] as { text: { text: string } }
    expect(section.text.text).toContain('IP `203.0.113.1`')
  })

  it('describes an account-scoped breach in Slack mrkdwn', () => {
    const result = renderSecurityFailedAuthThresholdSlack(ACCOUNT_PAYLOAD)
    const section = result.blocks[1] as { text: { text: string } }
    expect(section.text.text).toContain('user `user-123`')
  })

  it('falls back to "unknown" when ipAddress/userId is absent', () => {
    const { ipAddress: _ip, ...withoutIp } = IP_PAYLOAD
    const section = renderSecurityFailedAuthThresholdSlack(withoutIp).blocks[1] as {
      text: { text: string }
    }
    expect(section.text.text).toContain('IP `unknown`')
  })

  // Story 28.6 AC1 — Slack renderer parity with the email renderer's windowStart/windowEnd/
  // windowSeconds fallback fix.
  it('renders successfully with "unknown" window bounds when windowStart/windowEnd are missing', () => {
    const { windowStart: _ws, windowEnd: _we, ...withoutWindow } = IP_PAYLOAD
    expect(() => renderSecurityFailedAuthThresholdSlack(withoutWindow)).not.toThrow()
    const result = renderSecurityFailedAuthThresholdSlack(withoutWindow)
    expect(result.text).not.toContain('NaN')
    const context = result.blocks[2] as { elements: { text: string }[] }
    expect(context.elements[0]?.text).toContain('unknown')
  })

  it('renders successfully for the literal {} payload', () => {
    expect(() => renderSecurityFailedAuthThresholdSlack({})).not.toThrow()
    const result = renderSecurityFailedAuthThresholdSlack({})
    expect(result.text).not.toContain('NaN')
  })
})
