import { describe, expect, it } from 'vitest'
import { diffFiles, isBinary, unifiedDiff } from './diff.js'

describe('unifiedDiff', () => {
  it('prints hunks with context for changed, added and removed lines', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n'
    const newText = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n'
    expect(unifiedDiff(oldText, newText, 'old', 'new', 2)).toBe(
      [
        '--- old',
        '+++ new',
        '@@ -2,5 +2,5 @@',
        ' b',
        ' c',
        '-d',
        '+D',
        ' e',
        ' f',
        '@@ -9,2 +9,3 @@',
        ' i',
        ' j',
        '+k',
        '',
      ].join('\n')
    )
  })

  it('is empty for identical text', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y')).toBe('')
  })

  it('handles files without a trailing newline and says so', () => {
    const output = unifiedDiff('a\nb', 'a\nc', 'x', 'y')
    expect(output).toContain('-b')
    expect(output).toContain('+c')
    expect(output).toContain('\\ No newline at end of file')
  })

  it('handles an empty side', () => {
    expect(unifiedDiff('', 'a\n', 'x', 'y')).toContain('+a')
    expect(unifiedDiff('a\n', '', 'x', 'y')).toContain('-a')
  })

  it('gives up readably on a huge change instead of hanging', () => {
    const big = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n')
    const other = Array.from({ length: 6000 }, (_, i) => `other ${i}`).join('\n')
    expect(unifiedDiff(big, other, 'x', 'y')).toContain('too large to diff')
  })
})

describe('diffFiles', () => {
  it('reports binary files without dumping bytes', () => {
    const a = Buffer.from([0, 1, 2, 3])
    const b = Buffer.from([0, 1, 2, 4])
    expect(isBinary(a)).toBe(true)
    expect(diffFiles(a, b, 'x', 'y')).toBe('Binary files x and y differ\n')
  })

  it('diffs text bytes', () => {
    expect(diffFiles(Buffer.from('a\n'), Buffer.from('b\n'), 'x', 'y')).toContain('+b')
  })
})
