import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getFrameProtectionHeaders } from './hardening.js'

const sourceRoot = '/home/nestor/Proyects/project-vault/apps/web/src'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|svelte)$/.test(path) && !/\.test\.ts$/.test(path) ? [path] : []
  })
}

describe('static frontend hardening', () => {
  it('does not use browser storage APIs for token, MFA, or vault material', () => {
    const content = sourceFiles(sourceRoot)
      .map((file) => readFileSync(file, 'utf-8'))
      .join('\n')

    expect(content).not.toMatch(/\blocalStorage\b/)
    expect(content).not.toMatch(/\bsessionStorage\b/)
    expect(content).not.toMatch(/\bindexedDB\b/)
  })

  it('does not use raw HTML rendering', () => {
    const content = sourceFiles(sourceRoot)
      .map((file) => readFileSync(file, 'utf-8'))
      .join('\n')

    expect(content).not.toContain('{@html')
  })

  it('defines clickjacking protection headers for web responses', () => {
    expect(getFrameProtectionHeaders()).toEqual({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    })
  })
})
