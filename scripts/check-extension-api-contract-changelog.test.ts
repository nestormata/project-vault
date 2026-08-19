import { describe, expect, it } from 'vitest'
import {
  calculateContractHash,
  checkContractChangelog,
} from './check-extension-api-contract-changelog.js'

describe('extension API contract changelog guard', () => {
  it('accepts the content hash recorded for the current snapshots', () => {
    expect(checkContractChangelog(process.cwd())).toEqual({ ok: true })
  })

  it('detects a changed contract snapshot without consulting git history', () => {
    const expectedHash = calculateContractHash(process.cwd())
    const result = checkContractChangelog(process.cwd(), {
      snapshotText: '# changed surface\n',
      changelogText: `# Changelog\n\n## 1.4.0 — 2026-08-18\n\ncontract-hash: sha256:${expectedHash}`,
    })

    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('contract-hash')
  })

  it('requires all notification fields in deprecated changelog entries', () => {
    const result = checkContractChangelog(process.cwd(), {
      snapshotText: undefined,
      changelogText: '# Changelog\n\n## 1.5.0 — 2026-09-01\n\n### Deprecated\n\n- `OldFoo`\n',
    })

    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('Notified:')
    expect(result.errors?.join('\n')).toContain('earliest-removal:')
    expect(result.errors?.join('\n')).toContain('notice-window-ends:')
  })

  it('rejects a notification artifact without a date, channel, and recipient', () => {
    const result = checkContractChangelog(process.cwd(), {
      snapshotText: undefined,
      changelogText:
        '# Changelog\n\n## 1.4.0 — 2026-08-18\n\ncontract-hash: sha256:' +
        calculateContractHash(process.cwd()) +
        '\n\n## 1.5.0 — 2026-09-01\n\n### Deprecated\n\n- `OldFoo`\n- Notified: soon\n- earliest-removal: 2.0.0\n- notice-window-ends: 2026-12-01\n',
    })

    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('conforming Notified')
  })

  it('accepts a complete deprecated changelog section', () => {
    const changelog = `# Changelog

## 1.5.0 — 2026-09-01

contract-hash: sha256:${calculateContractHash(process.cwd())}

### Deprecated

- \`OldFoo\`
- Notified: 2026-09-01, GitHub issue centralizeme-sass#NNN
- earliest-removal: 2.0.0
- notice-window-ends: 2026-12-01
`

    expect(checkContractChangelog(process.cwd(), { changelogText: changelog })).toEqual({
      ok: true,
    })
  })

  it('requires the newest release entry to carry the current contract hash', () => {
    const hash = calculateContractHash(process.cwd())
    const result = checkContractChangelog(process.cwd(), {
      changelogText: `# Changelog\n\ncontract-hash: sha256:${hash}\n\n## 1.5.0 — 2026-09-01\n\n- Contract changed without an entry hash\n`,
    })

    expect(result.ok).toBe(false)
    expect(result.errors?.join('\n')).toContain('most recent CHANGELOG entry')
  })
})
