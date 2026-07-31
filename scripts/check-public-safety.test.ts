import { describe, expect, it } from 'vitest'
import { scanText } from './check-public-safety.js'

describe('check-public-safety', () => {
  it('detects literal secret material', () => {
    const findings = scanText('docs/example.md', 'api_key = "super-secret-value"')
    expect(findings.some((finding) => finding.rule === 'secret-assignment')).toBe(true)
  })

  it('detects personal and machine-specific information', () => {
    const findings = scanText(
      'notes.md',
      'Contact nestor@example.com; local worktree: /home/nestor/project/.worktrees/story; http://localhost:5173'
    )
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['personal-email', 'local-path', 'local-endpoint'])
    )
  })

  it('detects unresolved security details in planning artifacts', () => {
    const findings = scanText(
      '_bmad-output/implementation-artifacts/story.md',
      '- [ ] [Review][Patch] MFA issue left unfixed'
    )
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['unresolved-review-detail', 'security-implementation-detail'])
    )
  })

  it('does not flag ordinary implementation text', () => {
    expect(scanText('apps/web/src/lib/example.ts', 'export const answer = 42')).toEqual([])
  })
})
