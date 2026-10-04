# @project-vault/composition-kit

The MIT-licensed composer for [Project Vault](https://github.com/nestormata/project-vault)'s web
application. It copies PV's web source (`@project-vault/web-host`) into your app, overlays your own
`src/`-shaped UI pack on top, writes a committed `composition.lock.json`, and fails the build when
PV changed something you overrode or when your toolchain does not match the one PV was built with.

```bash
pnpm add -D @project-vault/composition-kit
pnpm add @project-vault/web-host
pnpm pv-compose --pack ../pv-ui          # compose, write composition.lock.json
pnpm pv-compose --pack ../pv-ui --check  # CI: fail when the committed lock is not current
```

Licence: **MIT**. The kit reads `web-host` (AGPL-3.0-or-later) as **data**: files on disk. It never
imports, copies or links its code, and a CI guard enforces that.

Supported platforms: Linux and macOS (POSIX paths). Node `>=20`. Windows is out of scope for 0.1.
Hashes and the lock are OS-independent.

## The UI pack

A directory with a `src/` and `static/` that mirror the composed app, a `pv-ui.manifest.ts`, and any
other code the manifest names:

```ts
// pv-ui.manifest.ts
import { defineUiPack } from '@project-vault/composition-kit'

export default defineUiPack({
  host: { pvRelease: '1.4.0' }, // the exact web-host version this pack targets
  routes: {
    overrides: [
      { path: 'src/routes/(app)/dashboard/+page.svelte', hostSha256: '…', story: 'ACME-1' },
    ],
    remove: ['/(app)/extensions/panels'], // route ids, files (src/..., static/...) or static assets
  },
  injections: {
    // a point from web-host's injection-points.json; load/actions are optional named exports
    'project.detail.after': [{ component: './injections/HealthTile.svelte', order: 10 }],
  },
  replacements: {
    '$lib/components/shell/GlobalSearch.svelte': {
      with: './replacements/GlobalSearch.svelte',
      hostSha256: '…',
    },
  },
  hooks: {
    server: './hooks.server.ts',
    universal: './hooks.universal.ts',
    client: './hooks.client.ts',
  },
  nav: './nav.ts',
  theme: './theme.css',
  messages: './messages',
  protectedPaths: { add: ['/billing'], remove: [] },
})
```

Nothing in the manifest is an allowlist: **any** file in PV's `src/` or `static/` can be overridden,
added or removed. The kit validates integrity only (hashes match, named files exist, nothing collides
by accident). `story` is informational.

### What the composer does, in order

1. Checks the compatibility tuple (below) **before** touching anything.
2. Copies `web-host`'s `src/`, `static/`, `messages/`, `project.inlang/` and `vendor/` into the app
   root as regular files (never symlinks), each generated directory with a "do not edit" header. The kit
   owns these directories and refuses to replace one without its header. List them in your app's own
   `.gitignore` (`/src/`, `/static/`, `/messages/`, `/project.inlang/`, `/inlang-plugins/`, `/vendor/`);
   the kit writes no `.gitignore` inside them, because Tailwind's scanner honours one and would then skip
   every composed file.
3. Overlays the pack's `src/` and `static/`. A pack file on an existing PV path is an **override** and
   must be declared with the PV file's `hostSha256`; an undeclared collision fails. A pack file on a new
   path is an **addition** (no declaration).
4. Applies `routes.remove`. A route id (`/(app)/extensions/panels`) removes its whole subtree, including
   files PV adds there later. A file entry starts with `src/` or `static/`. Removals are recorded with
   their hash; a later change to a removed file is informational.
5. Materializes the CM code the manifest names (and anything it imports from outside `src/`) under
   `src/lib/_cm/**` (`$cm`), or `src/lib/server/_cm/**` when it is server-only (a `server` directory
   segment, or a `.server.` file token, or named as server hooks / injection `load` / `actions` /
   a `$lib/server` replacement). Relative imports are rewritten by AST (TypeScript's and
   `svelte/compiler`'s own parsers, taken from your app as peer dependencies).
6. Appends the theme `@import` to the end of `src/app.css`, rewrites PV's shared `@source` to the
   vendored copy, and applies `messages` overlays to PV's catalogues.
7. Writes `composition.lock.json` atomically.

Your composed app then runs `paraglide compile`, `svelte-kit sync`, `svelte-check` and `vite build`.

### Wiring the app

```js
// apps/pv-composed/svelte.config.js
import { svelteConfig } from '@project-vault/web-host/svelte.config'
import { cmAlias } from '@project-vault/composition-kit'
export default svelteConfig({ composedRoot: import.meta.dirname, alias: { ...cmAlias() } })
```

`cmAlias()` returns `{ $cm: 'src/lib/_cm' }`. The composer never writes `svelte.config.js`. TypeScript
path aliases you define in your own tsconfig are not understood by the composer: an import that is not
relative is treated as a bare specifier and left alone.

```ts
// apps/pv-composed/vite.config.ts and vitest.config.ts (web-host 68-6 and later)
import { pvHooks } from '@project-vault/composition-kit/vite'
plugins: [pvHooks({ appRoot })]
```

`pvHooks()` generates `virtual:pv-hooks/server`, `/universal` and `/client` from the lock: your hook
files and the protected-path data. web-host refuses to build a composed tree without it. Each hook is a
chain entry ("yours first, then PV's") or `{ wrap: (pv) => replacement }`; `handle` also takes
`{ before, after, wrap }`, and the server file may export `headerPolicy: (pv) => policy` to add,
change or remove PV's security headers. Every CM route under `src/routes/(app)/` is protected by PV's
hook automatically (its exact route id); `protectedPaths.add` adds path prefixes and
`protectedPaths.remove` removes a prefix or a derived route. The full contract is in PV's
`docs/composition-kit.md` ("Hooks, header policy and protected paths").

## Navigation delta (M5)

`nav: './nav.ts'` names a module whose default export is your delta on top of PV's navigation: the
operations per nav surface, applied in order inside PV's nav models (so PV items you never touch,
including ones a later web-host adds, are inherited). web-host lists every surface and PV item id in
`manifests/nav-ids.json`.

```ts
// nav.ts (client-safe: it renders in the browser too, so never import $lib/server/*)
import { resolve } from '$app/paths'
import {
  defineNavDelta,
  hide,
  insert,
  move,
  relabel,
  replace,
} from '@project-vault/composition-kit/nav'

export default defineNavDelta({
  primary: [
    insert({
      after: 'primary.projects',
      item: { id: 'cm.billing', label: () => t('billing'), href: () => resolve('/billing') },
    }),
    insert({ parent: 'primary', item: { id: 'cm.ops', label: 'Ops', children: [] } }),
    move('primary.health', { parent: 'cm.ops' }),
    relabel('primary.secrets', () => t('vault')),
  ],
  'settings.index': [hide('settings.index.sso-domains')],
  'shell.brand': [replace('shell.brand.home', { label: 'CentralizeMe', href: () => resolve('/') })],
})
```

```ts
// vite.config.ts and vitest.config.ts
import { pvNav } from '@project-vault/composition-kit/vite'
plugins: [pvHooks({ appRoot }), pvNav({ appRoot })]
```

`pvNav()` serves `virtual:pv-nav` from the lock; web-host refuses to build a composed tree without
it. At compose time the kit records every string-literal id (`navIdsReferenced`, `navIdsDeclared`),
fails an operative reference to an id web-host no longer has, an id used under another surface, and an
id you insert that web-host now defines; everything else is a note. Ids passed as variables are noted
and checked by web-host's shipped `composed-nav.test.ts` in your CI. Hiding an item never protects its
route: use `protectedPaths` or the API's authorization. The full contract is in PV's
`docs/composition-kit.md` ("Navigation delta (M5)").

## Component and module replacement (M4)

`replacements` swaps any module under PV's `src/lib` (a Svelte component, a `$lib/server/*` module, a
`$lib/api/*` client) **by its resolved absolute path**, so every import of that file loads yours,
whichever way PV writes it (`$lib/...`, a relative path, with or without `?raw`). The composer
materializes your file under `src/lib/_cm/**` (`src/lib/server/_cm/**` for a `$lib/server` target) and
leaves PV's file untouched. The shadowing is done at build time by one Vite plugin.

```ts
// vite.config.ts: viteConfig() appends your plugins AFTER PV's, which is where pvReplace() belongs
// (pvHooks() is `enforce: 'pre'`, so its place in the list does not matter)
import { pvHooks, pvReplace } from '@project-vault/composition-kit/vite'
const plugins = [pvHooks({ appRoot }), pvReplace({ appRoot })]
export default viteConfig({ plugins }, { appRoot, composedRoot: appRoot })
```

- **The map.** `pv-compose` writes `.pv-compose/replacements.json` (`{ schemaVersion: 1, replacements:
[{ target, host, with }] }`, sorted, relative paths, deterministic) on every compose, an empty one when
  the manifest has no replacements. Add `/.pv-compose/` to your app's `.gitignore`: it is generated, never
  committed, and not part of the lock (the lock records the same facts). `pvReplace()` fails the build
  when the map is missing (a skipped compose would silently serve PV's originals), has an unknown
  `schemaVersion`, names a `with` file that is not there (`run pv-compose`), escapes `<appRoot>/src`, or
  lists an entry the committed lock does not.
- **Wrap PV's original first.** `import Original from 'pv-original:$lib/components/shell/ShellAccount.svelte'`
  gives your replacement PV's own file, resolved by the same specifier PV would write (`$lib/...`, or a
  relative path from your file, resolved straight from disk under `<appRoot>/src`; any other specifier
  goes through Vite's resolver) and returned unchanged, bypassing the map. This is the pattern to start
  from: render `<Original {...props} />` inside your own markup, or `export *` from the original module
  and override one function. It works in the client and in SSR.
- **A self-import is a cycle.** Importing the replaced target by its normal specifier from inside its
  own replacement resolves to the replacement itself. Use `pv-original:` to reach PV's file.
- **A replaced stateful module is two modules.** If you replace `$lib/state/theme.svelte.ts` and wrap the
  original, PV's original module instance (and its state) still exists next to yours, and PV's other
  files import yours. State is not shared between the two: re-export the original's store from the
  replacement.
- **Server modules stay server-only.** A `$lib/server/*` replacement lives under `src/lib/server/_cm`,
  so Kit's own guard still fails a client import of it. It runs in PV's web server process with the same
  trust as the file it shadows (CentralizeMe's UI is trusted first-party code; the kit adds no sandbox,
  no wrapper component and no `try`/`catch`).
- **Spellings.** Keys are `$lib/...` paths. A `.js`, `.jsx` or `.mjs` key matches the `.ts`, `.tsx` or
  `.mts` file (PV imports `$lib/state/theme.svelte.js` for `theme.svelte.ts`), with the same ambiguity
  rule as every other key.
- **Plugin order.** List `pvReplace()` AFTER PV's plugins, `sveltekit()` among them (what
  `viteConfig({ plugins: [pvReplace(...)] })` does). SvelteKit's import guard resolves every import
  itself to record who imports what, and only sees an import a later plugin answers; listed before it,
  `pvReplace()` answers first, so a client import of a replaced `$lib/server` module still fails the
  build but with "An impossible situation occurred" instead of SvelteKit's own message naming the
  import chain.
- **Unit tests.** To run PV's unit tests over a composed tree with the same replacements the build
  applies, list `pvReplace()` in the vitest `plugins` too (share one plugin list between
  `vite.config.ts` and `vitest.config.ts`). Without it the same import yields PV's original file.
  `vi.mock('$lib/x')` of a replaced file mocks the REPLACEMENT (the resolved id).
- **Types.** `pv-compose` also writes `src/lib/_cm/_pv-original.d.ts`, a generated, types-only
  `declare module 'pv-original:<specifier>'` for every replaced file, so a `pv-original:` import has PV's
  original type exactly (`@project-vault/composition-kit/pv-original` is the `.svelte` fallback for a file
  nothing replaced). **`svelte-check` types PV's call sites against PV's original file, not against your
  replacement:** a replacement that drops a required prop is not reported at PV's call site, so your own
  tests must cover the replacement's contract.
- **`@pv-stable` and `component-index.json` are signals, never gates.** `web-host` ships
  `manifests/component-index.json`: every UI module with `stability` (`stable` when the first comment of
  the file carries `@pv-stable`, otherwise `unmarked`; PV promises nothing about an unmarked one) and the
  raw-bytes SHA-256 you would put in `hostSha256`. The kit adds informational lock `notes`
  (`replacement <target>: stable`, a note for a server-side module, a note for a target not in the
  index). Any module may be replaced, stable or not; a note never fails a build.
- **Dev mode.** With `pvComposeDev`, adding, removing or retargeting a replacement reloads the map and
  invalidates the affected modules (and their importers) in the client and SSR graphs; no restart.

**Choosing between replacement and override or injection** (ADR 0007 guardrail 3): choose whichever
mechanism delivers the intended UX and behaviour. When two mechanisms deliver it **equally**, prefer the
one with the lower drift cost. Never accept a worse UX or missing behaviour to avoid an override: when
injection falls short, replacement or override is the correct choice, not a compromise.

## The lock and drift

`composition.lock.json` is committed. It holds hashes and paths only: no CM file content and no PV
file content, so committing it to a closed repository copies no AGPL source. It records the
compatibility tuple, every override (`hostSha256`, `cmSha256`, `story`, `hostVersion`), addition,
removal and replacement, the materialized files, the injection points used, and informational notes.
Keys and arrays are sorted and there are no timestamps or absolute paths, so the file is byte-identical
on every machine.

Hashes are SHA-256 over raw bytes, lowercase hex; line endings are never normalized (a CRLF checkout
changes only your own `cmSha256`).

- **Drift fails the build.** When an overridden or replaced PV file changed, the kit prints, for every
  drifted file, the CM file versus the **new** PV file as a unified diff (the lock holds only hashes, so
  it cannot print the old PV bytes). Pass `--previous-host <dir>` (an unpacked older web-host) to also
  print the true old-to-new PV diff.
- **`--accept-host <path>`** records the current PV hash of one declared override or replacement in the
  **lock** (never in your hand-written manifest). The manifest's `hostSha256` is the initial
  declaration; the lock is the authoritative accepted state. Repeat the flag for several files.
- **`--check`** exits non-zero when the committed lock differs from the regenerated one in its
  normative sections; `notes` and removed files' hashes are ignored.
- Informational, never failing: a removed file changed, an unmatched removal, an inherited PV nav item,
  a missing `story`, unknown manifest keys, a message key PV does not define (not merged).

## Compatibility tuple

`web-host` publishes `manifests/compatibility.json`: the PV release, the `extension-api` and kit
versions, and the exact Kit, Svelte, Vite and TypeScript versions it was built with. The composer
compares the **installed** versions resolved from the app root (never declared ranges) and the manifest's
`host.pvRelease`, and, with `--module-pack <dir>`, the module pack's `@project-vault/extension-api`. It
also requires every `web-host` runtime dependency to be a runtime dependency of the app at the identical
version. All mismatches are reported in one run. There is no flag to skip the check: align your versions.

## Guards and tests over a composed tree

`pv-verify --app <dir> [--host <dir>] [--pack <dir>] [--only guards|tests|classifications --out <file>] [--explain] [--json]`
runs, in order, and reports everything in one run: (1) **preflight**: the committed lock exists, matches
the web-host, and its generated guard entries are untouched (`--pack` also regenerates the lock like
`pv-compose --check`); (2) **guards**: every guard in web-host's `manifests/guards.json` over the
composed `src/` (including `src/lib/_cm`) with PV's own rules; (3) **tests**: `vitest run` over the
composed tree with **your app's own** `vitest.config.*` (then `vite.config.*`) at the app root, so tests see
the same plugins as the build (`pvHooks()`, `pvNav()`, `pvReplace()`); the config should call
`vitestConfig({ plugins }, { composedRoot })`, which excludes the lock's `excludedPvTests` (the step
hints when a failing suite is one of them). An app with no such config fails the step; the kit no longer
generates one. No coverage gate (CM owns its coverage policy). Exit `0` ok, `1` a guard, test or integrity
failure, `2` usage. A web-host without a guard registry fails (never silently skips); upgrade it.
`pv-verify` does not run `svelte-check` or lint (your pipeline's own steps).

**Route classifications for the runtime route audit.** A pack that adds raw (non-`secureRoute`) API routes
classifies them in `guards.routeClassifications`, one entry per route in the audit's own shape:
`{ route: 'GET /api/v1/cm/health', reason: 'public liveness probe' }` (optional `securityOwner`,
`compensatingControls: string[]`, `expiresAfterStory`, `revisitBy`, `temporary`; the route is the full URL
including the prefix, `OPTIONS *` is valid; any other field is rejected, including the old `method`, `url`
and `class`). The kit validates integrity only (shape, duplicates); it never decides which routes may be
public. Then, as the input of your CI's route audit step:

```bash
pv-verify --app <dir> --only classifications --out classifications.json
# the shipped form, from the API image (no Project Vault checkout; the package must resolve from the image):
docker run --rm --network none -v "$PWD:/audit:ro" <your-composed-api-image> \
  node dist/scripts/runtime-route-audit.js --extension <package> --classifications /audit/classifications.json
```

The checkout form (`pnpm --filter @project-vault/api route-audit:runtime ...`) runs the same code through `tsx`.
Exit `0` pass, `1` an audit failure or an extension that did not load, `2` a usage or input error; see
[docs/composition-kit.md](../../docs/composition-kit.md#runtime-route-audit-from-the-api-image-no-pv-checkout).

`--only classifications --out <file>` runs the preflight (lock current, generated entries untouched), then
writes the locked entries as a JSON array sorted by `route` (`[]` when there are none), atomically, and
runs no guard or test. It writes nothing when the preflight fails. Rules of the audit worth knowing: an
entry that restates a classification Project Vault already has is an **error** (the kit cannot see
Project Vault's table, so it emits no note), and a **stale** entry (a route not on the composed API)
**fails** the audit, so regenerate the file whenever the pack changes and use one file per composed
variant, never a shared union. The audit must run with API docs enabled (its CLI forces this).

**Pack guard entries.** Name a data module in the manifest (`guards: './pv-guards.ts'`) and author it with
`defineGuardEntries()`:

```ts
export default defineGuardEntries({
  browserStorage: {
    sessionStorage: [
      {
        file: 'src/lib/billing/draft.ts',
        keys: ['cm:billing-draft'],
        reason: 'non-sensitive draft id',
      },
    ],
    release: ['src/lib/theme/apply-theme.ts'], // only a PV file this pack overrode, replaced or removed
  },
  internalApiConsumers: { add: ['src/routes/billing/+page.server.ts'], release: [] },
})
```

Paths are pack-relative (as you see them); the composer maps them to composed paths. Every entry needs a
`reason`. Entries are reviewed under PV's rules: they carve a reviewed exception out of a PV guard by
exact path and never limit what your code may do. Every guard rule applies to your files exactly as to
PV's (no raw HTML of untrusted data, no browser storage outside reviewed entries, no raw `fetch` to the
internal API, labelled controls, a bounded Tailwind scan); a finding is fixed in your code.

Gotchas: a guard test file also holds PV unit assertions (for example the clickjacking headers in the
browser-storage guard); they run against your overrides of those modules and have no release. A test's
subjects (computed by PV, shipped in `manifests/test-subjects.json`) are its direct imports, its sibling
and what those reach inside `src/lib`, so a test of a component that imports a module you replaced is
excluded too and listed in the lock. Without `--pack`, `pv-verify` recomputes the exclusions from the
lock's own override, removal and replacement records and fails when the lock's `excludedPvTests`
differs (a hand edit); that checks the lock's internal consistency only, and `--pack` (or
`pv-compose --check`) stays the full proof.
`vendor/shared/src` is outside `src` and is not scanned, like PV's own tree.

## CLI

```
pv-compose --pack <dir> [--app <dir>] [--manifest <file>] [--host <dir>] [--lock <file>]
           [--module-pack <dir>] [--check] [--dry-run] [--accept-host <path>]... [--previous-host <dir>]
           [--verbose]
```

Exit codes: `0` success, `1` an integrity, drift, compatibility or `--check` failure (every problem is
printed in one run, then a count), `2` a usage error. `--dry-run` writes nothing.

`--module-pack <dir>` is the module pack's package root. Besides the extension-api version check, the kit
imports the pack's entry (`exports["."]`, else `main`; this runs the entry's top-level code) and records
its `apiRoutes.override` table in the lock's `apiRouteOverrides` section (`lockfileVersion` 2): one
`{ method, url, mode, replaceSecurity }` object per override, sorted. `hooksFactory()` is never called.
A pack dir with no `main`/`exports["."]` is tolerated (empty table plus a note); a declared entry that
is missing, throws or is malformed fails. A `lockfileVersion` 1 lock is read, rewritten as version 2 by the next `pv-compose`, and reported by
`--check` as a version mismatch.

## Dev mode

```ts
// vite.config.ts
import { pvComposeDev } from '@project-vault/composition-kit/vite'
plugins: [pvComposeDev({ appRoot, packRoot, hostDir })]
```

Runs the same composer in watch mode, mirrors pack and web-host changes (deleting an override restores
the PV file), invalidates registered virtual modules in the client and SSR module graphs when the
manifest changes, adds the pack directory to `server.fs.allow`, and keeps the last good tree when a
compose fails.

## Manifest loading

A `.ts` manifest is transpiled with your app's own `typescript` (types stripped, nothing else) into a
temporary sibling `.mjs`, imported and removed. `.json`, `.js` and `.mjs` load natively. This works on
Node 20 and 24 with no extra dependency. Loading runs your manifest as code: it is trusted first-party
code and the kit adds no sandbox. Keep the manifest self-contained apart from bare package imports.
