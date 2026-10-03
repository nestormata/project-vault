// Story 68.9 AC-4: the reviewed carve-outs of the browser-storage guard (`static-hardening.test.ts`),
// moved into data entry for entry. A file listed here may reference the named storage API, and only
// with the keys named here; every other file in the tree (PV or composed) may not use it at all.
// Paths are exact, app-relative and forward-slash: a path that merely ends the same is not exempt.
// Adding or widening an entry is a PV security decision that needs Nestor's sign-off.
export interface BaseStorageEntry {
  file: string
  keys: string[]
  reason: string
}

// Story 16.2 AC-3: the orphaned-theme dismissal notice is a transient, non-sensitive UI
// preference (which theme name the user last dismissed a "no longer available" banner for) and the
// pre-auth registration handoff (a user id plus locale, never a credential/session artifact), not
// token/MFA/vault material.
export const BASE_SESSION_STORAGE_ENTRIES: BaseStorageEntry[] = [
  {
    file: 'src/lib/theme/apply-theme.ts',
    keys: ['dismissedOrphanedTheme'],
    reason: 'non-sensitive orphaned-theme dismissal notice (Story 16.2 AC-3)',
  },
  {
    file: 'src/routes/(app)/+layout.svelte',
    keys: ['dismissedOrphanedTheme'],
    reason: 'non-sensitive orphaned-theme dismissal notice (Story 16.2 AC-3)',
  },
  {
    file: 'src/lib/components/auth/registration-locale.ts',
    keys: ['project-vault.registration-locale-pending'],
    reason: 'pre-auth registration handoff: a user id plus locale, no credential (Story 16.2 AC-3)',
  },
]

// Story 16.6 AC-1/AC-2: the pre-auth theme cache is the first (and, by design, only) use of
// persistent browser storage in `apps/web`: one versioned key holding a non-sensitive, org-admin-chosen theme
// name/CSS pair, never token/MFA/vault material.
export const BASE_LOCAL_STORAGE_ENTRIES: BaseStorageEntry[] = [
  {
    file: 'src/lib/state/theme.svelte.ts',
    keys: ['pv:preAuthTheme:v1'],
    reason: 'non-sensitive pre-auth theme name/CSS cache (Story 16.6 AC-1/AC-2)',
  },
]
