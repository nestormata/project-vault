import { describe, expect, it } from 'vitest'
import { undeclaredTestImports } from './test-imports-guard.js'

// Story 68.22 AC-3: every package a shipped test imports (at runtime or only as a type) must be a
// declared dependency or peer of the published package.

const DECLARED = {
  dependencies: { zod: '4.0.0' },
  peerDependencies: { vitest: '5.0.0', '@testing-library/dom': '10.4.2' },
}
const EXEMPT = ['@project-vault/shared', '@project-vault/extension-api']
const A_TEST = 'apps/web/src/a.test.ts'

describe('undeclaredTestImports', () => {
  it('accepts dependencies, peers and the exempt workspace packages', () => {
    const shipped = [
      { file: A_TEST, bareImports: ['@project-vault/shared', 'vitest', 'zod'] },
      { file: 'apps/web/src/b.test.ts', bareImports: ['@project-vault/extension-api'] },
    ]
    expect(undeclaredTestImports(shipped, DECLARED, EXEMPT)).toEqual([])
  })

  it('reports each undeclared package once, naming the first importing test, sorted', () => {
    const shipped = [
      { file: 'apps/web/src/b.test.ts', bareImports: ['left-pad2', 'vitest'] },
      { file: A_TEST, bareImports: ['left-pad', 'left-pad2'] },
    ]
    expect(undeclaredTestImports(shipped, DECLARED, EXEMPT)).toEqual([
      `shipped test ${A_TEST} imports left-pad, which is in neither dependencies nor peerDependencies`,
      'shipped test apps/web/src/b.test.ts imports left-pad2, which is in neither dependencies nor peerDependencies',
    ])
  })

  it('flags a missing peer such as a type-only @testing-library/dom', () => {
    const shipped = [{ file: A_TEST, bareImports: ['@testing-library/dom'] }]
    const noPeer = { dependencies: DECLARED.dependencies, peerDependencies: {} }
    expect(undeclaredTestImports(shipped, noPeer, EXEMPT)).toHaveLength(1)
    expect(undeclaredTestImports(shipped, DECLARED, EXEMPT)).toEqual([])
  })
})
