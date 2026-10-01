import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { applySinceAnnotations, validateSinceIndex } from '../tests/api-surface.js'
import { checkSurfaceFreshness, createSurfaceRunner } from '../tests/surface-runner.js'

// Story 66-6: the real public-surface program (src/index.ts + TypeScript libs + @types/node) is
// built exactly once per file run, in a child process that V8 coverage does not instrument. The
// three compiler-backed assertions below read that single, lazily produced result, so any one of
// them can run on its own (`-t readonly`). See tests/surface-runner.ts for why the build must
// never run in-process here (symbol-id drift, DW-310).
describe('extension API public type surface snapshot', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const compilerTestTimeoutMs = 15_000
  const surfaceRunner = createSurfaceRunner()
  const surfaceSection = (exportName: string): string => {
    const { snapshot } = surfaceRunner.generate(packageRoot)
    const start = snapshot.indexOf(`## export \`${exportName}\``)
    if (start === -1) return ''
    const end = snapshot.indexOf('\n## export ', start + 1)
    return snapshot.slice(start, end === -1 ? undefined : end)
  }

  it(
    'runs from the package test task and matches source, including nested members',
    () => {
      expect(checkSurfaceFreshness(packageRoot, surfaceRunner)).toEqual({ ok: true })
    },
    compilerTestTimeoutMs
  )

  it(
    'captures primitive property types in the public surface',
    () => {
      expect(surfaceSection('UIPanelContext')).toContain('- type: `string`')
    },
    compilerTestTimeoutMs
  )

  it(
    'captures readonly modifiers in the public surface',
    () => {
      expect(surfaceSection('ExtensionRegistrationError')).toContain('- member: `readonly reason`')
    },
    compilerTestTimeoutMs
  )

  it(
    'builds the full TypeScript program exactly once for every compiler-backed assertion',
    () => {
      surfaceRunner.generate(packageRoot)
      expect(surfaceRunner.buildCount()).toBe(1)
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

    expect(applySinceAnnotations(generated, previous, '2.0.0')).toBe(
      '## export `Existing`\n\n- since: 1.0.0\n- member: `old`\n  - since: 1.2.0\n- member: `new`\n  - since: 2.0.0\n'
    )
  })
})
