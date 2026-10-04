// The mock UI pack of PV's own mechanism e2e (Story 68.10). It exercises M1-M6 at the breadth of
// design section 12 against the REAL packed web-host, and is the UI half of
// `@project-vault/mock-ui-pack` (the module pack under ../module is its M7 half).
//
// Hashes are computed from the installed web-host when the manifest loads, never hard-coded, so a
// mere PV edit never needs a hash bump (the stale-hash case is a deliberate negative only). An
// override or replacement is declared only while its file exists in the pack, and every target is
// checked against the host: a PV file that moved fails with its path and capability named.
//
// Candidate targets are chosen for stability (files a PV PR rarely touches); the README records
// them so a churn-driven swap is a one-line change.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineUiPack } from '@project-vault/composition-kit'

const pack = fileURLToPath(new URL('.', import.meta.url))
const host = process.env.PV_FIXTURE_HOST ?? ''

const sha = (rel: string): string =>
  createHash('sha256')
    .update(readFileSync(join(host, rel)))
    .digest('hex')
/** The host route of the credential detail page's region points (`<routeId>#<scope>`). */
const CREDENTIAL_PAGE = '/(app)/projects/[projectId]/credentials/[credentialId]#page'
const release = (
  JSON.parse(readFileSync(join(host, 'manifests', 'compatibility.json'), 'utf8')) as {
    pvRelease: string
  }
).pvRelease

/** M1 page, layout, error, shell template, hooks and static overrides (capability: M1). */
const OVERRIDES = [
  'src/routes/(app)/dashboard/+page.svelte',
  'src/routes/(app)/dashboard/+page.server.ts',
  'src/routes/(auth)/recovery/+page.svelte',
  'src/routes/(auth)/recovery/+page.server.ts',
  'src/routes/(auth)/+layout.svelte',
  'src/routes/+error.svelte',
  'src/hooks.server.ts',
  'src/app.html',
  'static/favicon.png',
]

export default defineUiPack({
  host: { pvRelease: release },
  routes: {
    overrides: OVERRIDES.filter((path) => existsSync(join(pack, path))).map((path) => ({
      path,
      hostSha256: sha(path),
      story: 'MOCK-UI-PACK',
    })),
    // M1 route removal: PV's public status page route group is removed in this product.
    remove: ['/status'],
  },
  injections: {
    // M3: injected into NATIVE PV pages the pack did not override: a component with a server load
    // and a form action (settings home), a layout point and a head contribution.
    'settings.home.after': [
      {
        component: './injections/SettingsTile.svelte',
        order: 10,
        load: './injections/settings-tile.server.ts',
        actions: './injections/settings-tile.actions.ts',
      },
      { component: './injections/SettingsTileLate.svelte', order: 20 },
    ],
    'auth.login.after': [
      { component: './injections/LoginTile.svelte', load: './injections/login-tile.server.ts' },
    ],
    // M3 at REGION points (Story 69.1). `project.detail.tiles` is rendered by PV's own
    // `ProjectStatTiles` on the native project page; its load and action run through the host route
    // because the contribution opts in with `hostRoutes` (Q12 option B).
    'project.detail.tiles': [
      {
        component: './injections/ProjectTile.svelte',
        order: 10,
        load: './injections/project-tile.server.ts',
        actions: './injections/project-tile.actions.ts',
        hostRoutes: ['/(app)/projects/[projectId]#page'],
      },
    ],
    // `dashboard.home.activity` renders inside the pack's OWN dashboard override, which imports PV's
    // `RecentActivitySection` (override plus PV region components, the shape CM builds).
    'dashboard.home.activity': [
      {
        component: './injections/ActivityTile.svelte',
        load: './injections/activity-tile.server.ts',
        hostRoutes: ['/(app)/dashboard#page'],
      },
    ],
    // M3 at REGION points of PV's NATIVE credential detail page (Story 69.2), which the pack does not
    // override: the actions cluster (a component and a form action), the Shares section (a load and
    // two actions) and the metadata `<dl>` (a tile). Every behavior contribution opts in with
    // `hostRoutes`. The pack replaces no credential region component: PV's own page tests run over
    // the composed tree and a replaced region would break them (test subjects are not walked through
    // a route), so M4 on these regions is proven by the component index test instead.
    'credential.detail.actions': [
      {
        component: './injections/CredentialActionsFill.svelte',
        order: 10,
        actions: './injections/credential-actions.actions.ts',
        hostRoutes: [CREDENTIAL_PAGE],
      },
    ],
    'credential.detail.shares': [
      {
        component: './injections/CredentialSharesFill.svelte',
        order: 10,
        load: './injections/credential-shares.server.ts',
        actions: './injections/credential-shares.actions.ts',
        hostRoutes: [CREDENTIAL_PAGE],
      },
    ],
    'credential.detail.metadata': [{ component: './injections/CredentialMetadataFill.svelte' }],
    'app.layout.before': [{ component: './injections/LayoutBanner.svelte' }],
    'shell.head': [{ component: './injections/HeadMarker.svelte' }],
  },
  replacements: {
    // M4: a shell component replacement, a `$lib/server` module wrapped through `pv-original:`, a
    // wrapped shell component and a wrapped `$lib/api` module.
    '$lib/components/shell/Footer.svelte': {
      with: './replacements/Footer.svelte',
      hostSha256: sha('src/lib/components/shell/Footer.svelte'),
    },
    '$lib/components/shell/ShellAccount.svelte': {
      with: './replacements/ShellAccount.svelte',
      hostSha256: sha('src/lib/components/shell/ShellAccount.svelte'),
    },
    '$lib/api/audit.ts': {
      with: './replacements/audit.ts',
      hostSha256: sha('src/lib/api/audit.ts'),
    },
    '$lib/server/require-user.ts': {
      with: './replacements/require-user.ts',
      hostSha256: sha('src/lib/server/require-user.ts'),
    },
  },
  // M2: one CM route outside `(app)` declared protected, one under `(app)` declared public.
  protectedPaths: { add: ['/protected-cm'], remove: ['/(app)/cm-area/public-callback'] },
  // M5: the nav delta (every operation on native and pack items, nested, inherited; see nav.ts).
  nav: './nav.ts',
  // M6: tokens (colors, radius, font) plus the pack's own styles.
  theme: './theme.css',
  messages: './messages',
})
