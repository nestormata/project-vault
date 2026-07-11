# Project Vault — Brand Color Brief (Story 11-1)

## Source assets
- `design/brand-source/project-vault-icon.png` — padlock/acorn mark, 1024x1024
- `design/brand-source/project-vault-logo.png` — squirrel mascot + wordmark, 1024x1024

Both source PNGs have a soft radial "glow" background baked into the alpha
channel (fully transparent at the corners, fading to a translucent
brown/grey haze near the subject) rather than a flat transparent field.
`convert -trim +repage` removes the fully-transparent border; the residual
haze is faint enough to read cleanly on white or slate app surfaces.

## Extracted palette (ImageMagick `-colors 12 -unique-colors`)

| Swatch | Hex | Where |
|---|---|---|
| Deep brown | `#6B3F1D` | acorn cap shading |
| Mid brown | `#995C26` | acorn cap |
| Burnt orange | `#CD7B2D` | acorn body / padlock body |
| Tan-orange | `#AE7C48` | acorn body highlight |
| Gold | `#ECAF2F` | padlock shackle |
| Cream | `#FDECAD` | shackle highlight |
| Red-orange | `#AA3119` | squirrel ears/nose accents |
| Orange-red | `#DD5527` | squirrel body |
| Orange | `#E09630` | squirrel body highlight |
| Peach | `#F1A668` | squirrel face/belly |
| Cream | `#FBE4A5` | squirrel face highlight |
| Brown | `#9D5624` | wordmark "Project Vault" |

Dominant hue family: warm orange/amber (~15°–45° hue), i.e. the same
neighborhood as the app's existing `amber` (warning) and `red` (error)
semantic colors. This ruled out picking an accent directly from the logo's
own palette — it would visually collide with warning/error states.

## Color-theory reasoning

Rather than lift a literal logo color (which sits in the red/amber hue
range already claimed by semantic states), the brand accent was chosen as a
**triadic partner** to the logo's dominant orange (~30° hue). A triad of
orange sits at roughly 30° / 150° / 270°; 150° is taken by `emerald`
(success), so **270°(violet/purple)** is the one open triadic slot. Violet
also carries the right connotation for a password-vault product — richness,
security, "premium" — echoing the padlock/gold-key imagery without
competing with it chromatically.

Concretely, the accent is **Tailwind's `violet` scale**, anchored at
`violet-600` (`#7c3aed`, hue 262°, high saturation, mid-lightness) — close
enough to the outgoing `indigo-600` (`#4f46e5`, hue 243°) in saturation and
lightness that link/interactive affordances keep the same visual weight,
but shifted ~19° further from the logo's warm hues and unambiguously its
own identity rather than a generic default.

### Recommended shade ramp

| Token | Hex | Use |
|---|---|---|
| `brand-50` | `#f5f3ff` | subtle tinted backgrounds/hover fills |
| `brand-100` | `#ede9fe` | selected/active state backgrounds |
| `brand-500` | `#8b5cf6` | secondary accents, icons |
| `brand-600` | `#7c3aed` | **primary accent** — links, interactive highlights (replaces `indigo-600`) |
| `brand-700` | `#6d28d9` | hover/pressed state for `brand-600` |

## WCAG contrast evidence

Computed via relative-luminance formula (WCAG 2.x):

| Color | Contrast vs white `#ffffff` | Passes 4.5:1 (text/links)? |
|---|---|---|
| `brand-500` `#8b5cf6` | 4.23:1 | No — reserve for non-text UI only |
| **`brand-600` `#7c3aed`** | **5.70:1** | **Yes** |
| `brand-700` `#6d28d9` | 7.10:1 | Yes |

`brand-600` (#7c3aed) is the shade to bind to link/interactive-text roles;
it clears 4.5:1 with headroom (5.70:1), matching or exceeding the outgoing
`indigo-600` (`#4f46e5`, ~7.5:1 — slightly higher, but 5.70:1 is comfortably
compliant).

## Distinctiveness vs. existing semantic colors

Hue values (HSL) at the `-600` step:

| Role | Color | Hue |
|---|---|---|
| Error | `red-600` `#dc2626` | 0° |
| Warning | `amber-600` `#d97706` | 32° |
| Success | `emerald-600` `#059669` | 161° |
| Info | `sky-600` `#0284c7` | 200° |
| **Brand accent** | **`violet-600` `#7c3aed`** | **262°** |

Minimum hue separation from any semantic color is 62° (vs. `sky`), and 98°
vs. the nearest warm color (`red`). No confusion risk with error, warning,
success, or info states.

## Asset files produced

All written to `apps/web/static/` (created fresh — directory did not exist
before this story):

| File | Dimensions | Size | Purpose |
|---|---|---|---|
| `apps/web/static/logo.png` | 238×240 | 47 KB | Header/nav lockup (squirrel + wordmark), trimmed of transparent padding, resized from 1024×1024 original (1.5 MB → 47 KB) |
| `apps/web/static/icon.png` | 512×512 | 123 KB | Clean square mark (padlock/acorn), transparent background, for future PWA manifest use |
| `apps/web/static/favicon.png` | 32×32 | 1.6 KB | Browser tab favicon |
| `apps/web/static/apple-touch-icon.png` | 180×180 | 20.5 KB | iOS home-screen icon |

Pipeline: `convert -trim +repage` to strip the fully-transparent border →
(icon only) `-gravity center -background none -extent <square>` to pad
back to a square canvas before downscaling → `-resize` to target
dimensions. Source-to-favicon size reduction: ~1.4 MB → 1.6 KB.

Not touched in this pass (deferred to implementation): `AppShell.svelte`,
`PrimaryNav.svelte`, `(auth)/+layout.svelte`, `app.css`, `app.html`.
