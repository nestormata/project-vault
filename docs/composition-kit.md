# The composition kit (`@project-vault/composition-kit`)

The kit is Project Vault's half of build-time UI composition (ADR 0007, design sections 2, 3, 4, 9
and 11). [`@project-vault/web-host`](web-host-package.md) publishes PV's web source; the kit composes
a consumer's own `src/`-shaped UI pack onto it **before compilation**, locks what it changed, and
fails the build on drift or on a version mismatch. PV's own `apps/web` build, image and tests never
run kit code and do not change.

- **Licence:** MIT (`packages/composition-kit`). `web-host` and the rest of PV stay
  AGPL-3.0-or-later. The kit reads `web-host` as **data** (files on disk). It never imports, copies
  or vendors AGPL source. `pnpm check-composition-kit-boundary` (in `make ci-inner`) fails when a kit
  file imports `apps/web`, `@project-vault/web-host` or any workspace package, when a kit file is a
  byte copy of an `apps/web` file, or when a production dependency of the kit is not permissively
  licensed (MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak).
- **First consumer:** CentralizeMe's `apps/pv-composed`. The kit is generic: its vocabulary is
  `pv-ui` and `pack`, and its README example uses `@acme/pv-ui`.
- **Nothing here narrows M1-M7.** The composer has no allowlist of overridable paths and never rejects
  a declared override, removal, replacement or injection. Every validation checks integrity only.

## The pipeline

```text
pv-compose  ->  paraglide compile  ->  svelte-kit sync  ->  svelte-check  ->  guards and tests  ->  vite build
```

1. **Tuple check, before any copying** (below).
2. **Copy** `web-host`'s `src/`, `static/`, `messages/`, `project.inlang/` and `vendor/` into the app
   root as regular files (never symlinks or hardlinks). Each generated directory carries a
   `.pv-compose-generated` header (and no `.gitignore` inside: Tailwind's scanner honours one and would
   skip every composed file, so the app's own `.gitignore` lists them). The kit owns these directories and
   refuses to replace one that has no header. It also refuses to run when the app root is a filesystem
   root, a home directory, has no `package.json`, or overlaps `web-host` or the pack.
3. **Overlay** the pack's `src/` and `static/`. A pack file on an existing PV path is an *override* and
   must be declared in `routes.overrides` with the PV file's `hostSha256`; an undeclared collision
   fails (an integrity check against accidental shadowing, resolved by declaring it). A pack file on a
   new path is an *addition* (M2) and needs no declaration.
4. **Removals** (`routes.remove`): a route id such as `/(app)/extensions/panels` removes its whole
   subtree, including files PV adds there later; a `src/...` or `static/...` entry removes that file
   or directory. Removals are recorded with their hash. A changed removed file is informational. A
   removal that matches nothing is informational too (the end state already holds).
5. **Materialize** CM code that is not at a route path under `src/lib/_cm/**` (`$cm`), or
   `src/lib/server/_cm/**` when it is server-only. The set is the transitive closure of the files the
   manifest names plus every pack file outside `src/` and `static/` that an overlay file imports.
   Relative imports are rewritten by AST (the app's own `typescript` and `svelte/compiler`, taken as
   peer dependencies). Kit's own server-only guard then rejects a client import of server-only CM code.
6. **CSS and messages.** The theme `@import` is appended to the **end** of the composed
   `src/app.css`; PV's shared `@source` is rewritten (located by its marker comment) to the vendored
   copy; CM files get `@source` lines. A pack `messages/<locale>.json` overrides PV's own message keys
   and adds locales PV lacks. CM's own strings are not merged (ADR 0007 decision 7); a key PV does not
   define is reported as a note.
7. **Lock.** `composition.lock.json` is written atomically.

`compose()` is a pure `plan()` (reads, computes, writes nothing) plus an `apply()` that builds the tree
in a `0700` temp directory next to the target and swaps it in, so a failure leaves the previous tree
intact. `--dry-run` and `--check` use the plan only.

## The manifest and the lock

See the [package README](../packages/composition-kit/README.md) for the manifest shape and the CLI.
`composition.lock.json` is committed. It holds hashes and paths only (no CM or PV file content), has
sorted keys and arrays and no timestamps or absolute paths, and validates against
[`composition.lock.schema.json`](../packages/composition-kit/schema/composition.lock.schema.json).
It records the compatibility tuple, every override (`hostSha256`, `cmSha256`, `story`, `hostVersion`),
addition, removal and replacement, the materialized files, the contributions later stories apply
(hooks, nav, theme, protected paths), the injection points used, and informational notes. The sections
`excludedPvTests` and `apiRouteOverrides` are written empty: Story 68-9 fills the first, Stories
68-3/68-8 (whichever lands second) wire the second.

## Drift and the upgrade flow

Drift **fails** the build when an overridden or replaced PV file changed, when an injection point CM
uses vanished and CM did not cause it by overriding the page that contained it, or when an operative
nav id vanished. It is **informational** when a removed file changed, PV added an item CM inherits, or
a vanished id is only hidden or removed.

The lock stores only hashes, so the report prints, for each drifted file, **CM's file against the NEW
PV file** (a unified diff: what your override now differs from). With `--previous-host <dir>` it also
prints the true old-to-new PV diff. `hostVersion` in the lock records the PV release each hash was
accepted at, so a reconciliation can fetch the old tarball from npm.

Upgrade flow (design section 11):

1. Bump the PV versions (`@project-vault/web-host`, the kit, and the Kit/Svelte/Vite/TypeScript
   versions the new tuple names).
2. `pv-compose` lists every drifted file in one run.
3. A reconciliation story updates each override or replacement.
4. `pv-compose --accept-host <path>` records the new hash (repeat the flag for several files). It
   writes the **lock only**, never CM's hand-written manifest: the manifest's `hostSha256` is the
   initial declaration and the lock is the authoritative accepted state. It refuses a path that is not
   declared and does nothing when the hash is already accepted.
5. Run the mechanism tests and CM's own end-to-end tests.

`pv-compose --check` (CI) fails when the committed lock differs from the regenerated one in the
normative sections (`compatibility`, `overrides`, `additions`, `replacements`, `materialized`,
`contributions`, `injectionPointsUsed`, `navIdsReferenced`, `apiRouteOverrides`, and the removals'
paths). `notes` and the removed files' hashes never fail it.

## The version tuple

`web-host`'s `manifests/compatibility.json` names the PV release, the `extension-api` version, the
kit version (`kitVersion`), the exact Kit, Svelte, Vite and TypeScript versions and the API image
tag. The composer compares the **installed** versions it resolves from the app root (never declared
ranges), `@project-vault/composition-kit`'s own installed version, the manifest's `host.pvRelease`,
and, with `--module-pack <dir>`, the module pack's `@project-vault/extension-api`. It also requires
every `web-host` runtime dependency to be a runtime dependency of the app at the identical version
(`adapter-node` externalizes only `dependencies`). All mismatches are reported in one run. There is no
flag to skip the check: a skippable gate is the allowlist pattern this project rejects.

## Releasing

The kit has its own semver (`packages/composition-kit/package.json`, mirrored by `src/version.ts` and
asserted equal by `pnpm exec tsx scripts/check-release-version-triangle.ts composition-kit --tag <v>`).
It publishes from the same PV `vX.Y.Z` tag as `web-host`, in the `publish-kit` job of
`.github/workflows/web-host-release.yml`, which **runs before `publish`**: `web-host`'s compatibility
manifest names the kit version, so the kit must be on npm first (`publish` refuses a real upload when
it is not). Always dist-tag `next`, OIDC provenance, the `npm-publish` environment, Node 24 leg only;
a PV release that does not change the kit does not re-publish it. A PV prerelease tag (`v1.4.0-rc.1`)
publishes `web-host@1.4.0-rc.1` but the kit keeps its own version.

Maintainer-only, never done by CI or an agent (Story 68-13): the npm trusted-publisher entry for the
kit, a bootstrap publish if npm needs the package to exist first, the `Composition kit integration`
required check, the first real publish, and promotion to `latest`.

## Verifying

- `pnpm --filter @project-vault/composition-kit test` runs the kit's unit tests with coverage.
- `make composition-kit-integration` (CI job `Composition kit integration`) packs the real `web-host`
  and the kit, installs them from the tarballs into a fresh directory outside the repository under
  `env -i`, composes a small pack, then runs paraglide compile, `svelte-kit sync`, `svelte-check
  --fail-on-warnings`, the shipped unit tests and `vite build`, boots the built server and asserts over
  HTTP and in the built CSS. Variants prove that `svelte-check` fails on a lying `./$types`, that
  Kit's server-only guard rejects a client import of materialized server-only code (and accepts the
  same import from `+page.server.ts`), and that the Vite dev plugin mirrors a pack edit, an added
  route and a deleted override.
