import { describe, expect, it } from 'vitest'
import { findUntrackedReviewDeferrals, hasTrackedFollowUp } from './check-story-review-deferrals.js'

describe('check-story-review-deferrals', () => {
  it('detects an unchecked review deferral without a follow-up story', () => {
    const content = '- [ ] [Review][Patch] Auth shell remains English — deferred for later\n'

    expect(findUntrackedReviewDeferrals(content, new Map())).toEqual([
      expect.objectContaining({ line: 1 }),
    ])
  })

  it('accepts an unchecked review deferral with a live backlog follow-up key', () => {
    const content =
      '- [ ] [Review][Patch] Auth shell remains English — deferred. Follow-up: `19-2-localize-pre-auth-shell-and-mfa-copy`\n'
    const statuses = new Map([['19-2-localize-pre-auth-shell-and-mfa-copy', 'backlog']])

    expect(hasTrackedFollowUp(content, statuses)).toBe(true)
    expect(findUntrackedReviewDeferrals(content, statuses)).toEqual([])
  })

  it('rejects a follow-up key that is not in sprint status', () => {
    const content =
      '- [ ] [Review][Patch] Dashboard selector is limited — follow-up: `19-2-missing`\n'

    expect(hasTrackedFollowUp(content, new Map())).toBe(false)
  })

  it('ignores checked review findings and ordinary prose', () => {
    const content = [
      '- [x] [Review][Patch] Fixed the race — deferred test now passes',
      'The future story is intentionally not part of this implementation plan.',
    ].join('\n')

    expect(findUntrackedReviewDeferrals(content, new Map())).toEqual([])
  })
})
