import { describe, expect, it } from 'vitest'
import { REQUIRED_POLICY_HEADINGS, checkPolicyDocument } from './check-policy-doc-structure.js'

describe('extension API policy document guard', () => {
  it('accepts the tracked public document, canonical README URL, and required headings', () => {
    expect(checkPolicyDocument(process.cwd())).toEqual({ ok: true })
  })

  it('identifies the missing heading instead of accepting a partial policy', () => {
    const result = checkPolicyDocument(process.cwd(), {
      policyText: '# Policy\n\n## Status\n',
      readmeText:
        'See https://github.com/nestormata/project-vault/blob/main/docs/extension-api-versioning-policy.md',
      tracked: true,
    })

    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        `policy document is missing required heading: ${REQUIRED_POLICY_HEADINGS[1]}`,
      ]),
    })
  })

  it('rejects a relative README pointer and an untracked policy', () => {
    const result = checkPolicyDocument(process.cwd(), {
      policyText: REQUIRED_POLICY_HEADINGS.join('\n'),
      readmeText: 'See ../../docs/extension-api-versioning-policy.md',
      tracked: false,
    })

    expect(result).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        'docs/extension-api-versioning-policy.md is not git-tracked',
        'packages/extension-api/README.md must contain the canonical absolute HTTPS policy URL',
      ]),
    })
  })
})
