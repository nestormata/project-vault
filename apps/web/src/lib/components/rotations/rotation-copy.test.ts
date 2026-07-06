import { describe, expect, it } from 'vitest'
import {
  checklistItemStatusBadgeClass,
  checklistItemStatusLabel,
  rotationCopy,
  rotationStatusBadgeClass,
  rotationStatusLabel,
} from './rotation-copy.js'

describe('rotation copy and status badges', () => {
  it('shares a single "No rotations yet." empty-state string (AC-1/AC-18)', () => {
    expect(rotationCopy.noRotationsYet).toBe('No rotations yet.')
  })

  it('conveys checklist item status via text, not color alone (AC-26)', () => {
    expect(checklistItemStatusLabel('unconfirmed')).toBe('unconfirmed')
    expect(checklistItemStatusLabel('confirmed')).toBe('confirmed')
    expect(checklistItemStatusLabel('failed')).toBe('failed')
    expect(checklistItemStatusLabel('max_retries_exceeded')).toBe('max retries exceeded')
  })

  it('maps checklist item statuses to distinct badge classes', () => {
    expect(checklistItemStatusBadgeClass('unconfirmed')).toContain('slate')
    expect(checklistItemStatusBadgeClass('confirmed')).toContain('emerald')
    expect(checklistItemStatusBadgeClass('failed')).toContain('red')
    expect(checklistItemStatusBadgeClass('max_retries_exceeded')).toContain('red')
  })

  it('maps rotation statuses to labels and badge classes', () => {
    expect(rotationStatusLabel('in_progress')).toBe('in_progress')
    expect(rotationStatusBadgeClass('completed')).toContain('emerald')
    expect(rotationStatusBadgeClass('abandoned')).toContain('slate')
    expect(rotationStatusBadgeClass('stale_recovery')).toContain('amber')
    expect(rotationStatusBadgeClass('break_glass_complete')).toContain('red')
  })
})
