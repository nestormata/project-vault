import { describe, expect, it } from 'vitest'
import { checkPolicyContent, REQUIRED_POLICY_CONTENT } from './check-policy-doc-content.js'

describe('extension API policy content smoke guard', () => {
  it('covers a positive content anchor set for every acceptance criterion', () => {
    expect(Object.keys(REQUIRED_POLICY_CONTENT)).toHaveLength(17)
    expect(checkPolicyContent(process.cwd())).toEqual({ ok: true })
  })

  it('reports the acceptance criterion and missing anchor when policy prose drifts', () => {
    const result = checkPolicyContent(process.cwd(), '## Status\n## Change classification\n')
    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('AC-2')
    expect(result.errors?.join('\n')).toContain('The Obligation Rule')
  })
})
