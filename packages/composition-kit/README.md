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
    overrides: [{ path: 'src/routes/(app)/dashboard/+page.svelte', hostSha256: '…', story: 'ACME-1' }],
    remove: ['/(app)/extensions/panels'], // route ids, files (src/..., static/...) or static assets
  },
  injections: { 'project.detail.tiles': [{ component: './injections/HealthTile.svelte', order: 10 }] },
  replacements: { '$lib/components/shell/GlobalSearch.svelte': { with: './replacements/GlobalSearch.svelte', hostSha256: '…' } },
  hooks: { server: './hooks.server.ts' },
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
   root as regular files (never symlinks), each generated directory with a "do not edit" header and a
   catch-all `.gitignore`. The kit owns these directories and refuses to replace one without its header.
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

## CLI

```
pv-compose --pack <dir> [--app <dir>] [--manifest <file>] [--host <dir>] [--lock <file>]
           [--module-pack <dir>] [--check] [--dry-run] [--accept-host <path>]... [--previous-host <dir>]
```

Exit codes: `0` success, `1` an integrity, drift, compatibility or `--check` failure (every problem is
printed in one run, then a count), `2` a usage error. `--dry-run` writes nothing.

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
