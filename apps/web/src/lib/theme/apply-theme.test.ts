import { describe, expect, it } from 'vitest'
import {
  ORPHANED_THEME_DISMISSAL_KEY,
  isOrphaned,
  readDismissedOrphanedTheme,
  resolveAppliedTheme,
  resolveAppliedThemeWithOrgDefault,
  shouldShowOrphanedNotice,
  writeDismissedOrphanedTheme,
} from './apply-theme.js'

describe('resolveAppliedTheme (AC-2/AC-3)', () => {
  it('returns the selected theme name when it is currently available', () => {
    expect(resolveAppliedTheme('acme-brand', ['acme-brand', 'other'])).toBe('acme-brand')
  })

  it('returns null (base theme) when no theme is selected', () => {
    expect(resolveAppliedTheme(null, ['acme-brand'])).toBeNull()
  })

  it('AC-3: falls back to null (base) when the selected theme is no longer available (orphaned)', () => {
    expect(resolveAppliedTheme('removed-theme', ['acme-brand'])).toBeNull()
  })
})

describe('resolveAppliedThemeWithOrgDefault (Story 16.4 AC-2/AC-6)', () => {
  it('personal selection wins over the org default when both are currently valid', () => {
    expect(
      resolveAppliedThemeWithOrgDefault('morgan-dark', 'acme-brand', ['morgan-dark', 'acme-brand'])
    ).toBe('morgan-dark')
  })

  it('org default applies when personal selection is null', () => {
    expect(resolveAppliedThemeWithOrgDefault(null, 'acme-brand', ['acme-brand'])).toBe('acme-brand')
  })

  it('org default itself orphaned falls back to base (null)', () => {
    expect(resolveAppliedThemeWithOrgDefault(null, 'old-brand', ['acme-brand'])).toBeNull()
  })

  it('neither personal selection nor org default set falls back to base (regression, zero behavior change)', () => {
    expect(resolveAppliedThemeWithOrgDefault(null, null, ['acme-brand'])).toBeNull()
  })

  it('a personal selection that is orphaned falls through to a currently-valid org default, not straight to base', () => {
    expect(resolveAppliedThemeWithOrgDefault('removed-theme', 'acme-brand', ['acme-brand'])).toBe(
      'acme-brand'
    )
  })

  it('a personal selection that is orphaned and an org default that is also orphaned falls back to base', () => {
    expect(
      resolveAppliedThemeWithOrgDefault('removed-theme', 'also-removed', ['acme-brand'])
    ).toBeNull()
  })
})

describe('isOrphaned (AC-3)', () => {
  it('is false when nothing is selected', () => {
    expect(isOrphaned(null, ['acme-brand'])).toBe(false)
  })

  it('is false when the selection is currently available', () => {
    expect(isOrphaned('acme-brand', ['acme-brand'])).toBe(false)
  })

  it('is true when the selection is no longer in the available set', () => {
    expect(isOrphaned('removed-theme', ['acme-brand'])).toBe(true)
  })
})

describe('shouldShowOrphanedNotice (AC-3 dismissal-key design)', () => {
  it('shows the notice when nothing has been dismissed yet', () => {
    expect(shouldShowOrphanedNotice('acme-brand', null)).toBe(true)
  })

  it('hides the notice once that exact orphaned theme name has been dismissed', () => {
    expect(shouldShowOrphanedNotice('acme-brand', 'acme-brand')).toBe(false)
  })

  it('re-shows the notice for a newly-orphaned DIFFERENT theme even if another was already dismissed', () => {
    expect(shouldShowOrphanedNotice('second-theme', 'acme-brand')).toBe(true)
  })
})

function fakeSessionStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    },
  } as Storage
}

describe('dismissal sessionStorage helpers (AC-3)', () => {
  it('reads null when nothing has been dismissed', () => {
    expect(readDismissedOrphanedTheme(fakeSessionStorage())).toBeNull()
  })

  it('round-trips a written dismissal under the documented key', () => {
    const storage = fakeSessionStorage()
    writeDismissedOrphanedTheme(storage, 'acme-brand')
    expect(readDismissedOrphanedTheme(storage)).toBe('acme-brand')
    expect(storage.getItem(ORPHANED_THEME_DISMISSAL_KEY)).toBe('acme-brand')
  })
})
