import { describe, expect, it } from 'vitest'
import {
  isOrphaned,
  resolveAppliedTheme,
  resolveAppliedThemeWithOrgDefault,
  shouldShowOrphanedNotice,
} from './apply-theme.js'

const ACME_BRAND = 'acme-brand'
const MORGAN_DARK = 'morgan-dark'
const REMOVED_THEME = 'removed-theme'
const ALSO_REMOVED = 'also-removed'

// Story 25.3 AC4/Task 1 — this is the canonical, shared copy `apps/web` (visible app shell) and
// `apps/api` (renderExtensionPanel()'s theme.name context field) both call; these are the exact
// same test cases apps/web/src/lib/theme/apply-theme.test.ts already asserted before the move, so
// coverage does not regress across the relocation.

describe('resolveAppliedTheme (AC-2/AC-3)', () => {
  it('returns the selected theme name when it is currently available', () => {
    expect(resolveAppliedTheme(ACME_BRAND, [ACME_BRAND, 'other'])).toBe(ACME_BRAND)
  })

  it('returns null (base theme) when no theme is selected', () => {
    expect(resolveAppliedTheme(null, [ACME_BRAND])).toBeNull()
  })

  it('AC-3: falls back to null (base) when the selected theme is no longer available (orphaned)', () => {
    expect(resolveAppliedTheme(REMOVED_THEME, [ACME_BRAND])).toBeNull()
  })
})

describe('resolveAppliedThemeWithOrgDefault (Story 16.4 AC-2/AC-6)', () => {
  it('personal selection wins over the org default when both are currently valid', () => {
    expect(
      resolveAppliedThemeWithOrgDefault(MORGAN_DARK, ACME_BRAND, [MORGAN_DARK, ACME_BRAND])
    ).toBe(MORGAN_DARK)
  })

  it('org default applies when personal selection is null', () => {
    expect(resolveAppliedThemeWithOrgDefault(null, ACME_BRAND, [ACME_BRAND])).toBe(ACME_BRAND)
  })

  it('org default itself orphaned falls back to base (null)', () => {
    expect(resolveAppliedThemeWithOrgDefault(null, 'old-brand', [ACME_BRAND])).toBeNull()
  })

  it('neither personal selection nor org default set falls back to base (regression, zero behavior change)', () => {
    expect(resolveAppliedThemeWithOrgDefault(null, null, [ACME_BRAND])).toBeNull()
  })

  it('a personal selection that is orphaned falls through to a currently-valid org default, not straight to base', () => {
    expect(resolveAppliedThemeWithOrgDefault(REMOVED_THEME, ACME_BRAND, [ACME_BRAND])).toBe(
      ACME_BRAND
    )
  })

  it('a personal selection that is orphaned and an org default that is also orphaned falls back to base', () => {
    expect(resolveAppliedThemeWithOrgDefault(REMOVED_THEME, ALSO_REMOVED, [ACME_BRAND])).toBeNull()
  })
})

describe('isOrphaned (AC-3)', () => {
  it('is false when nothing is selected', () => {
    expect(isOrphaned(null, [ACME_BRAND])).toBe(false)
  })

  it('is false when the selection is currently available', () => {
    expect(isOrphaned(ACME_BRAND, [ACME_BRAND])).toBe(false)
  })

  it('is true when the selection is no longer in the available set', () => {
    expect(isOrphaned(REMOVED_THEME, [ACME_BRAND])).toBe(true)
  })
})

describe('shouldShowOrphanedNotice (AC-3 dismissal-key design)', () => {
  it('shows the notice when nothing has been dismissed yet', () => {
    expect(shouldShowOrphanedNotice(ACME_BRAND, null)).toBe(true)
  })

  it('hides the notice once that exact orphaned theme name has been dismissed', () => {
    expect(shouldShowOrphanedNotice(ACME_BRAND, ACME_BRAND)).toBe(false)
  })

  it('re-shows the notice for a newly-orphaned DIFFERENT theme even if another was already dismissed', () => {
    expect(shouldShowOrphanedNotice('second-theme', ACME_BRAND)).toBe(true)
  })
})
