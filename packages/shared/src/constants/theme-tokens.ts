/**
 * Story 16.1 AC-4 — canonical theme token registry. Every token a theme file is permitted to
 * declare must appear here with its declared type; the theming service (apps/api's
 * modules/theming/service.ts) rejects any key not present in this registry, and validates every
 * declared value against its type's grammar before compiling it into a `[data-theme]` CSS
 * custom-property block. This registry — not the theme file itself — is the single source of
 * truth for "what CSS custom properties can a theme ever set."
 *
 * Follows the same const-object + derived-type pattern already established by
 * `AuditEvent`/`OperationalEvent` in this same directory.
 */
export type ThemeTokenDefinition =
  { type: 'color' } | { type: 'length' } | { type: 'enum'; values: readonly string[] }

export const THEME_TOKENS = {
  colorPrimary600: { type: 'color' },
  colorPrimary700: { type: 'color' },
  colorBackground: { type: 'color' },
  colorForeground: { type: 'color' },
  colorBorder: { type: 'color' },
  radiusMd: { type: 'length' },
  radiusLg: { type: 'length' },
  spacingUnit: { type: 'length' },
  fontWeightBody: { type: 'enum', values: ['normal', 'medium', 'bold'] },
  // Story 72.2 (P1a): keys are ADDED, never replaced or renamed. Semantic colours, the colour
  // painted on an accent background (`colorTextOnAccent`, honoured by the contrast guard), focus
  // ring, a stronger control border, density, motion and font family.
  colorSurface: { type: 'color' },
  colorSurfaceMuted: { type: 'color' },
  colorTextMuted: { type: 'color' },
  colorTextOnAccent: { type: 'color' },
  colorFocusRing: { type: 'color' },
  colorBorderStrong: { type: 'color' },
  colorSuccess: { type: 'color' },
  colorWarning: { type: 'color' },
  colorDanger: { type: 'color' },
  colorInfo: { type: 'color' },
  focusRingWidth: { type: 'length' },
  density: { type: 'enum', values: ['compact', 'comfortable', 'spacious'] },
  motion: { type: 'enum', values: ['full', 'reduced', 'none'] },
  typeFamily: { type: 'enum', values: ['sans-serif', 'serif', 'monospace'] },
} as const satisfies Record<string, ThemeTokenDefinition>

export type ThemeTokenKey = keyof typeof THEME_TOKENS
