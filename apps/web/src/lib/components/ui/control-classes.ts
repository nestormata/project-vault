/**
 * @pv-stable: the exported names and their class strings are the shared-controls contract (Story
 * 72.3). Class strings for the shared form controls, in one place.
 *
 * The control border is the M6 `--color-border-strong` token with the literal `#64748b` as the
 * fallback (D-10: the old `#cbd5e1` border is 1.48:1 on white, the new one is above the 3:1 the WCAG
 * 1.4.11 non-text contrast criterion asks for). The 72.2 contrast guard holds a theme's own value to
 * 3:1 against its background.
 */

/** The D-10 control border: a theme token with the default value as fallback. */
export const CONTROL_BORDER = 'border-[color:var(--color-border-strong,#64748b)]'

/** The default value of the border, for the contrast test and the docs. */
export const CONTROL_BORDER_FALLBACK = '#64748b'

/** A text-like control: input, select, textarea. `aria-invalid` turns the border red. */
export const TEXT_CONTROL_CLASS = `w-full rounded-xl border ${CONTROL_BORDER} px-3 py-2 aria-invalid:border-red-700`

/** A checkbox or radio: the native glyph, tinted by the accent colour. */
export const CHOICE_CONTROL_CLASS = 'h-4 w-4 accent-brand-600'

export type ButtonSize = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'secondary' | 'danger'

function sizeClass(size: ButtonSize): string {
  if (size === 'sm') return 'px-3 py-1.5 text-sm'
  if (size === 'lg') return 'px-5 py-3 text-lg'
  return 'px-4 py-2'
}

/** `[fill, text]`: the pieces around the size and weight, so `primary` + `md` is today's class
 * string byte for byte. */
function variantClasses(variant: ButtonVariant): readonly [string, string] {
  if (variant === 'secondary') {
    return [`border ${CONTROL_BORDER} bg-white`, 'text-slate-900 hover:bg-slate-50']
  }
  if (variant === 'danger') return ['bg-red-700', 'text-white hover:bg-red-800']
  return ['bg-brand-600', 'text-white hover:bg-brand-700']
}

/** The class string of a button. Width is the content's unless `fullWidth`. */
export function buttonClass(size: ButtonSize, variant: ButtonVariant, fullWidth: boolean): string {
  const [fill, text] = variantClasses(variant)
  return [
    'rounded-xl',
    fill,
    sizeClass(size),
    'font-semibold',
    text,
    'disabled:cursor-not-allowed disabled:opacity-60',
    fullWidth ? 'w-full' : '',
  ]
    .filter(Boolean)
    .join(' ')
}
