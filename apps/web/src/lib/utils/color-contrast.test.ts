import { describe, expect, it } from 'vitest'
import { contrastRatio, relativeLuminance } from './color-contrast.js'

describe('color-contrast', () => {
  it('computes maximum contrast (21:1) between pure black and pure white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
  })

  it('computes minimum contrast (1:1) for two identical colors', () => {
    expect(contrastRatio('#334155', '#334155')).toBeCloseTo(1, 5)
  })

  it('is symmetric regardless of argument order', () => {
    expect(contrastRatio('#020617', '#a78bfa')).toBeCloseTo(contrastRatio('#a78bfa', '#020617'), 5)
  })

  it('relativeLuminance treats near-black as much darker than a light color', () => {
    expect(relativeLuminance('#020617')).toBeLessThan(relativeLuminance('#a78bfa'))
  })
})
