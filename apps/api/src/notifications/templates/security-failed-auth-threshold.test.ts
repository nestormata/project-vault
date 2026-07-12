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
})
