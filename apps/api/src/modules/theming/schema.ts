import { z } from 'zod/v4'

export const ThemeReloadFailureSchema = z.object({
  file: z.string(),
  reason: z.string(),
})

export const ThemeReloadResponseSchema = z.object({
  loaded: z.array(z.string()),
  failed: z.array(ThemeReloadFailureSchema),
})

export type ThemeReloadResponse = z.infer<typeof ThemeReloadResponseSchema>

// Story 16.2 AC-1: `css` carries the exact `[data-theme="name"] { ... }` block 16.1 already
// compiles and validates (CSS-injection-hardened grammar) — `null` for the base theme, which
// never gets a compiled `[data-theme="base"]` block (it's just the app's default stylesheet).
// The client (apps/web/src/lib/theme/apply-theme.ts) is the only consumer of this field; it never
// reaches a Svelte template's `{@html}` (forbidden by this repo's static-hardening gate) — it's
// injected via a plain DOM `<style>` element's `textContent`, a normal/safe browser API.
export const ThemeListItemSchema = z.object({
  name: z.string(),
  label: z.string(),
  css: z.string().nullable(),
})

// Story 16.2 AC-1/AC-2 — deliberately a flat, non-paginated-envelope shape (see Dev Notes'
// Self-Consistency Validation note): the compiled-themes list is small and bounded, consistent
// with 16.1's own flat `{ loaded, failed }` reload response.
export const ThemeListResponseSchema = z.object({
  themes: z.array(ThemeListItemSchema),
  // The caller's own raw stored selection — may reference a theme name that is no longer in
  // `themes` (an "orphaned" selection, AC-3's second edge case). The client is responsible for
  // rendering that distinction, not this endpoint.
  selected: z.string().nullable(),
})

// Story 16.2 AC-2's Zod-hardening edge case: `themeName` is bounded to `max(100)` *before* the
// live compiled-themes-list membership check, so a malformed/oversized request is rejected cheaply
// (O(1)) rather than relying solely on the more expensive O(n) list-membership check.
export const ThemeSelectionBodySchema = z
  .object({ themeName: z.string().max(100).nullable() })
  .strict()

export const ThemeSelectionResponseSchema = z.object({
  themeName: z.string().nullable(),
})

export type ThemeListResponse = z.infer<typeof ThemeListResponseSchema>
export type ThemeSelectionBody = z.infer<typeof ThemeSelectionBodySchema>
export type ThemeSelectionResponse = z.infer<typeof ThemeSelectionResponseSchema>
