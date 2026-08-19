import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  applySinceAnnotations,
  assertSurfaceSnapshotIsFresh,
  validateSinceIndex,
} from '../tests/api-surface.js'

describe('extension API public type surface snapshot', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const compilerTestTimeoutMs = 15_000

  it(
    'runs from the package test task and matches source, including nested members',
    () => {
      expect(assertSurfaceSnapshotIsFresh(packageRoot)).toEqual({ ok: true })
    },
    compilerTestTimeoutMs
  )

  it(
    'captures primitive property types in the public surface',
    async () => {
      const { generateSurfaceSnapshot } = await import('../tests/api-surface.js')
      const panelContext = generateSurfaceSnapshot(packageRoot).match(
        /## export `UIPanelContext`[\s\S]*?(?=\n## export |$)/
      )?.[0]

      expect(panelContext).toContain('- type: `string`')
    },
    compilerTestTimeoutMs
  )

  it(
    'captures readonly modifiers in the public surface',
    async () => {
      const { generateSurfaceSnapshot } = await import('../tests/api-surface.js')
      const registrationError = generateSurfaceSnapshot(packageRoot).match(
        /## export `ExtensionRegistrationError`[\s\S]*?(?=\n## export |$)/
      )?.[0]

      expect(registrationError).toContain('- member: `readonly reason`')
    },
    compilerTestTimeoutMs
  )

  it('rejects a snapshot with a missing since annotation', () => {
    expect(validateSinceIndex('## export Foo\n- member: value\n').join('\n')).toContain(
      'missing since'
    )
  })

  it('rejects a since version newer than the package API version', () => {
    expect(validateSinceIndex('## export Foo\n- since: 9.0.0\n').join('\n')).toContain('exceeds')
  })

  it('requires since annotations on index signatures', () => {
    expect(
      validateSinceIndex(
        '## export Foo\n- since: 1.0.0\n- index-signature: `[string]: string`\n'
      ).join('\n')
    ).toContain('missing since')
  })

  it('preserves existing since versions and dates new surface entries at the current version', () => {
    const generated =
      '## export `Existing`\n\n- since: 1.0.0\n- member: `old`\n  - since: 1.0.0\n- member: `new`\n  - since: 1.0.0\n'
    const previous = '## export `Existing`\n\n- since: 1.0.0\n- member: `old`\n  - since: 1.2.0\n'

    expect(applySinceAnnotations(generated, previous, '1.4.0')).toBe(
      '## export `Existing`\n\n- since: 1.0.0\n- member: `old`\n  - since: 1.2.0\n- member: `new`\n  - since: 1.4.0\n'
    )
  })
})
