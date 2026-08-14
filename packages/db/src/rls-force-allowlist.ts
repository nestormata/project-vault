// Deliberately empty: every currently RLS-enabled table must have FORCE enabled. If a future table
// has a documented reason to remain ENABLE-only, add it here with a story/AC reference rather than
// weakening the catalog query. Keep this extension point separate from the catalog query so static
// analysis does not treat the intended empty steady state as a provably constant false branch.
export const RLS_FORCE_ALLOWLIST = new Set<string>()
