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
3. **Overlay** the pack's `src/` and `static/`. A pack file on an existing PV path is an _override_ and
   must be declared in `routes.overrides` with the PV file's `hostSha256`; an undeclared collision
   fails (an integrity check against accidental shadowing, resolved by declaring it). A pack file on a
   new path is an _addition_ (M2) and needs no declaration.
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
(hooks, nav, theme, protected paths), the injection points used, every injection contribution (composed
paths, `order`, route id and scope; an optional section a lock written before 0.2.0 lacks) and informational
notes. `excludedPvTests` is written empty (Story 68-9 fills it).

`apiRouteOverrides` (lockfileVersion 2, Story 68-14) records the module pack's `apiRoutes.override`
table for review: one `{ method, url, mode, replaceSecurity }` object per override, the url normalized
like the host's route key (leading slash, no trailing slash), sorted by `METHOD url`. It is recorded,
never refused, and `--check` compares it (a flipped `replaceSecurity` or a new override fails the check,
naming `apiRouteOverrides`). `apiRoutes.add` entries are not recorded. Without `--module-pack` the table
is empty.

`--module-pack <dir>` is the module pack's package root. A dir whose `package.json` has no `main` or
`exports["."]` is tolerated (the flag also feeds the extension-api version check): the kit records an empty
`apiRouteOverrides` and prints an informational note. An entry that is declared but missing, throws on
import, or has a malformed manifest still fails naming the pack. The kit resolves the entry from
`<dir>/package.json` (`exports["."]`, else `main`), imports it and reads `default.manifest.apiRoutes`
only; it never calls `hooksFactory()`. **Importing runs the entry's top-level code**, exactly like
building the pack does, in the kit's own working directory and with the process's own env (the kit adds
nothing); the entry must be built JavaScript, and its resolved path must stay inside `<dir>` (a symlink
that escapes is refused). An import that throws, a missing entry or a module without `default.manifest`
fails `pv-compose`, naming the pack (the printed error is its name and the first 500 characters of its
message) and leaves the lock untouched. The extension-api version check against the tuple runs first: a
pack built against another version is never imported.

### lockfileVersion 2 migration

Version 2 changed `apiRouteOverrides` from a list that was always empty to the object list above. A
version 1 lock is still read: `pv-compose` rewrites it as version 2 (and prints one migration line), and
`pv-compose --check` on a version 1 lock fails with a message naming both versions (run `pv-compose` and
commit the lock), never with a diff or a silent pass. A lock from a newer kit is refused.

## Injection points

Injection points are how a pack adds components and behavior to a native PV page without overriding it
(M3). PV renders `<InjectionPoint name="project.detail.after" ... />` at named places; a pack lists what
goes there in its manifest's `injections`.

**Choosing between injection and override** (ADR 0007 guardrail 3, decided by Nestor 2026-09-30): choose
whichever mechanism delivers the intended UX and behaviour. When injection and override deliver it
**equally**, prefer injection (lower drift cost). Never accept a worse UX or missing behaviour to avoid an
override; when injection falls short, the override is the correct choice, not a compromise. A point that
does not exist yet never blocks a pack: override the page (M1) or replace the component (M4) the same day,
and ask for the point in PV (a repeated need is a PV story).

- **Names** follow `<area>.<page>.<region>[.<position>]`: lowercase, dot-separated, hyphens allowed inside a
  segment (`project.service-endpoints.after`). Shell points have two segments (`shell.head`). Every PV page,
  layout and error file renders `<prefix>.before`, `<prefix>.after` and `<prefix>.header.actions`; a layout
  and its page cannot share a prefix, so layouts use `<area>.layout` (`project.layout`) and the root error
  file is `root.error`. The shell exposes `shell.head` (inside `<svelte:head>`, after PV's own head content),
  `shell.header.end` (authenticated pages) and `shell.body.end`. A `shell.head` component renders plain head
  markup (`<meta>`, `<link>`): it is already inside PV's `<svelte:head>`, and a nested `<svelte:head>` makes
  Svelte 5 log `hydration_mismatch` on every page.
- **The registry** is `apps/web/src/lib/components/composition/injection-points.ts` (names, kinds and the
  props each point passes). `pnpm pack:web-host` joins it with the files that render each point and ships
  `manifests/injection-points.json` (`schemaVersion` 1: `name`, `file`, plus `kind`, `propsType`, `routeId`
  and `scope`, which the kit uses to route behavior). The composer fails on a name the registry does not
  have, and only notes it when the pack itself overrode the page that held the point.
- **Contributions** are `{ component, order?, load?, actions?, hostRoutes? }`, with `order` ascending (default 0, ties keep
  manifest order). `component` is any Svelte component; it runs in PV's own document, router, stores and
  session, with no sanitizer, wrapper or boundary, and receives `routeId`, `params`, the page's primary
  entity where it has one (`project`, `credential`) and `data`.
- **`load`** is a pack file with a named `export const load`. PV's `injectLoad(event, '<route id>', '<scope>')`
  runs it after PV's own load finished (a PV redirect or error short-circuits), with the SAME `RequestEvent`,
  concurrently with the other contributions. The result reaches the component as `data`: `data.__inject['<point>']`
  is an array aligned with the point's contributions (`null` where a contribution has no `load`). Redirects and
  errors a contribution throws pass through; any other throw is rethrown as
  `injection "<point>" load failed: <ErrorName>` with the original as `cause`. **Never return secrets from a
  contribution `load`:** its data is serialized to the browser, and on a public route (register, status, shares) it
  is served to anonymous visitors.
- **`actions`** is a pack file with a named `export const actions = { ... }`. Each action is exposed as
  `?/<point>.<name>` on the point's page (`?/credential.detail.after.share`), through Kit's normal form pipeline
  (CSRF origin check included). Two contributions at one point cannot export the same name. Kit forbids a
  `default` action next to named ones: if the PV page exports `default`, the composition fails with "PV story
  needed: convert the default action to a named one, or override the page (M1)".
- **Layout and page data merge shallowly** in SvelteKit, so a page's `__inject` replaces its layout's. Every
  file's points read the `data` of their own file; do not deep-merge.
- **`fallback`** renders only when a point has no contribution (PV's own build: every point is empty).
- **PV's own build is unchanged**: `injectLoad` resolves to `{}` and `injectActions` returns `undefined` (so Kit
  keeps its 405 for a stray POST). `+error.svelte` has no load; its points get `data` only from an ancestor
  layout load that ran.
- **Dispatch is keyed by (route id, scope)** (`/(app)/projects/[projectId]#page` and `#layout`), because a
  layout and its page share a route id.
- **Region points and the per-route opt-in `hostRoutes`** (Story 69-1, Nestor's Q12 option B). A point inside a
  shared `$lib` component has scope `component` and no route of its own, so its `load` and `actions` run only
  where the contribution says: `hostRoutes: ['<routeId>#<scope>']`, the same key shape as above
  (`'/(app)/projects/[projectId]#page'`). The kit then adds the point to that host route's behavior table:
  the load runs with the member's own `RequestEvent` and its result reaches the component as
  `data.__inject['<point>'][i]`, exactly as for a standard point. The registry lists the routes that render each
  region (`hostRoutes` in `injection-points.json`, derived from the import graph and checked against the
  declaration in `injection-points.ts`), and a `hostRoutes` entry that is not one of them fails the composition
  naming the point, the entry and the valid routes (integrity only: the name does not exist). Never an
  allowlist: a pack that does not opt in still gets its component, props and `data = null` (the lock records
  the load and actions, inert, with a note), and naming a route is free. A duplicate entry is dropped, an empty
  list ("opted in to nothing") and a `#layout` host for a region only a page renders fail, `actions` are
  refused on a layout host, and when the pack overrides the host route's server file the kit notes that the
  override must call `withInjectedLoad` / `injectActions` (CM's own code; PV's guards cannot check it). A
  web-host that predates `hostRoutes` keeps components-only injection working and answers an opt-in with
  "needs a newer web-host"; an older kit ignores the additive field.
- **A `notFound` or a `vaultSealed` result skips contribution loads** (DW-490 item 1, Story 69-2). When PV's own
  load answers `notFound: true` (a 404 or another org's id, for the project page, the project layout and the
  credential page alike) or `vaultSealed: true` (every PV API call answers 503: the dashboard and the credential
  page), `withInjectedLoad` runs no contribution load and gives every contribution a `null` entry. That way a
  contribution that calls the API for the same id can neither turn PV's 404 into a 500 nor tell a foreign id
  from a missing one, and cannot turn PV's friendly sealed banner into an error page. Only the literal `true`
  counts, and the point's `data` stays aligned (`null` per contribution). A form action is not covered:
  SvelteKit runs actions without running the page `load`, so an injected action on a `[projectId]` or
  `[credentialId]` page authorizes itself through the API (RLS is the enforcement, and a foreign id answers like
  a missing one). Point props (`orgRole`, `projectRole`, `project`, `credential`) are display data, never
  authorization input: a composed action decides from server state, never from a posted role field. The
  endpoint list and detail routes return `notFound: true` too, so a foreign or nonexistent endpoint id runs no
  contribution load either.
- **A PV denial skips contribution loads too** (Story 69-7, DW-531). `withInjectedLoad` skips every contribution
  load, with one `null` entry per contribution, when PV's own result is `notFound: true`, `vaultSealed: true`,
  the typed `skipInjectedLoads: true` marker, or a literal `allowed: false` (PV's own denial vocabulary on the
  settings and platform pages: audit, access report, forwarding, SSO domains, extensions, external identities and
  the platform pages). Only the literal `true` / `false` counts. The members page marks a 403 or 404 from the
  member list with `SKIP_INJECTED_LOADS` (exported from `inject-behavior.ts`, stripped from the page data); a
  5xx or network failure is not a denial and keeps today's degrade-to-empty behavior with contributions running.
  This does not narrow M1-M7, and a fill must still authorize itself.
- **A typed `skipInjectedLoads: true` marker does the same where PV's "nothing here" answer has another shape**
  (Story 69-3). The public status page (`/status/<token>`) answers an invalid, disabled or sealed-vault token
  with `statusPage: null`; its own load marks that result `skipInjectedLoads: true`, so no contribution load
  runs for it (a pack cannot use its own load as a token-validity oracle, and the three cases stay one
  identical response). `withInjectedLoad` consumes the marker and strips it from the returned data, so PV's own
  data shape is unchanged. **Public-page rule:** a region on `/status/<token>` is anonymous. Its `load` runs
  without `locals.user`, only for a valid token, and its result is serialized into public HTML and
  `__data.json`: return public-safe data only (never the token, never anything that varies by viewer), and
  own the cost of the extra server call per anonymous request. The page's `actions` are anonymous too and rely
  on Kit's origin check; PV's own public status API limiter is unaffected.
- **Failure modes you own.** A contribution `load` that throws takes the whole page to the error page (all
  loads settle first, the failing one with the lowest `order` is reported by point name and error name only).
  A hung load hangs the page: PV sets no timeout, because a PV timeout would be a limit on CM; use your own
  `AbortSignal` on `event.fetch`. With a sealed vault PV renders its banner and runs no contribution load (see
  above). A contribution `load` that throws after a successful PV mutation (`invalidateAll()` after an archive
  or a new version re-runs every load) turns the page into an error page: PV does not catch for CM, so a load
  must not throw for a data miss. A region that renders on a route whose server file dropped `withInjectedLoad` (a CM
  override) gets `data = null` and never throws.
- **Region points** (Story 69-1) sit INSIDE the marked element (the guards require the point in the subtree of
  the node `<!-- @region name -->` marks), adjacent to a sibling so PV's own markup gains no whitespace node:
  `project.detail.tiles` and `dashboard.home.project-summary` render at the end of their stat `<dl>`, so their
  fills should be `<div><dt/><dd/></div>` shaped; `dashboard.home.suggested-actions` at the end of its `<ul>`
  (fills are `<li>`); `dashboard.home.monitoring` at the start of the grid; the others after their content.
  A region point renders only when its region renders. The monitoring regions of Story 69-3 render their point
  right after the PV component they wrap (outside its card, as its sibling; the per-row point and the history,
  link and services points sit inside their cell or card): PV's own markup is byte-identical because the
  wrapper emits no element. **The per-row region** `project.service-endpoints.row` is one point rendered N
  times, inside the row's Monitoring cell (never between `<tr>` siblings); its `data` is the page's
  `__inject` entry, not per row, so a fill that needs per-row data reads `props.endpoint.id`.
  `project.detail.export` receives `{ project }` only:
  the one-time export key never reaches a contribution. The regions are `project.detail.{summary,export,tiles,
not-found}`, `project.layout.nav` and `dashboard.home.{vault-sealed,org-summary,project-summary,rotations,
activity,monitoring,suggested-actions,summary-unavailable,empty}`, each a component you can replace (M4).
  Story 69-3 adds the monitoring regions: `project.service-endpoints.{header,alerts,table,row,empty,not-found}`,
  `project.service-endpoints-new.{header,form}`,
  `project.service-endpoints-detail.{title,pause,settings,history,delete,not-found}`,
  `project.status-page.{header,read-only,disabled,link,services}` and `status.detail.{header,services,unavailable}`.
  Per state: the not-found regions render in the not-found state only; `project.status-page.read-only` renders
  instead of the manage regions for a caller who cannot manage, and `disabled` / `link` / `services` render only
  for a manager (`disabled` when the page is off, `link` and `services` when it is on). The
  `project.status-page.link` point receives `{ project, hasPublicUrl, isLegacy }`: never the public token or the
  URL built from it.

**Credential detail regions (Story 69-2).** The credential page (`/projects/[projectId]/credentials/[credentialId]`)
has the three standard points and 13 region points, every point receiving ONE props contract:
`{ routeId, params, credential, project, projectId, credentialId, orgRole, projectRole }` (`credential` is `null`
in the sealed and not-found states, `projectRole` is `project?.role ?? null`; additive, so a fill written against
`{ credential }` keeps working). The props never carry a revealed value, a share token or a step-up secret: those
live in the owning component's local state. The regions are `credential.detail.{vault-sealed,not-found,summary,
actions,nudges,metadata,lifecycle,value,versions,dependencies,rotation,shares,footer}`, each a component under
`$lib/components/credentials/detail/` you can replace (M4). `credential.detail.actions` renders in the header
card's action cluster for every role (PV hides nothing, the fill decides); `credential.detail.metadata` renders at
the end of the metadata `<dl>`, so a fill must be a tile-shaped `<div><dt/><dd/></div>` block. The Shares region is
two levels: the OUTER `CredentialSharesRegion` (section chrome, the `credential.detail.shares` point at its end)
renders the INNER native sharer body `CredentialSharesNative`; replace the inner one (M4) and your own fill at
`credential.detail.shares` still renders, replace the outer one and its point goes with it. A fill reaches the
action result without PV forwarding anything: `use:enhance` receives the `ActionResult`, and the no-JS path
re-renders the page with `page.form` (`$app/state`) readable from any component. After a SUCCESSFUL enhanced action Kit re-runs the page load; after a failed one (a denied or rate-limited action, `fail(403)`, `fail(429)`) `use:enhance` applies the result and leaves the loads alone, so a fill that needs fresh data then calls `invalidateAll()` itself (the no-JS POST always re-renders the page and re-runs every load). Where a region's PV control is
conditional (`nudges`, `lifecycle`, `actions`, `footer`), its component takes the point as its `children`
snippet, so the point renders whether or not the PV control does. Credential context reaches CentralizeMe through
these point props, `params` and the server load event, never through a panel (the withdrawn 65-1 panel forwarding
is superseded).

The kit's `pvInject()` Vite plugin (`@project-vault/composition-kit/vite`, `enforce: 'pre'`) serves
`virtual:pv-inject/<point>` (the point's components, statically imported, in order) and
`virtual:pv-inject-behavior` (the load and action tables) from the lock's `injections` section. PV's own
build resolves the same ids to empty lists through `emptyInjectionModules()`, and PV's `injectionEntries()`
transform adds the static per-point import to every `<InjectionPoint>` with a literal `name` (an ES import
cannot take a variable, so a non-literal name is a build error). Add `pvInject({ lockPath })` to the
consumer's Vite config next to `pvComposeDev`.

`scripts/check-injection-point-coverage.ts` is a PV CI guard: every PV route file renders its three standard
points, every `<!-- @region name -->` block (a comment before an element or block, used in `$lib` components)
contains a point, every name is registered, and every page and layout server file calls `injectLoad` /
`injectActions` with its own route id and scope. Run over a composed tree with `--lock composition.lock.json`,
it skips the files the lock records as CM's.

**Monolithic regions (Story 68.10).** `scripts/check-monolithic-regions.ts` (`pnpm check-monolithic-regions`,
shipped as the `monolithic-region` guard in `apps/web/guards/monolithic-region.ts` and run by `pv-verify` over a
composed tree) adds a second rule to the same `<!-- @region name -->` marker: the marked block must be a component
or contain one, so it can be replaced individually through M4. A component is a capitalized tag (or a dotted
member) whose binding is imported from a `.svelte` file in the same file's scripts, a `<svelte:component>`, or a
`{@render}` marked node. `<InjectionPoint>` never counts, so a region that is only plain HTML and a point is
monolithic. The check is about replaceability, not size: a region wrapped in a trivial component passes (whether
the extraction is meaningful is the componentization audit of story 69.5). An unparseable `.svelte` file is a
finding, never a silent skip. Files the lock records as CM's are exempt by provenance (the guard has
`@pv-scope pv-originated-only`); there is no suppression syntax, baseline or allow-list. PV's own tree has 189
`@region` markers since Story 69-6 (21 added by 69-6 to the 168 that held after Story 69-5; before 69-5 there were 66 after Story 69-3, made of 14 from story 69-1: the project page, the project nav and the dashboard; 13 from
story 69-2: the credential detail page; 17 from story 69-4: the settings audit, settings notifications and project
members pages; 22 from story 69-3: the endpoint list, add and detail pages, the status page admin screen and the
public status page; Story 69-5 added the rest, so every route file holds regions; see "Region points" below); the guard prints the count (`scanned N files, 189 regions`) and a test
pins it from below, and a per-file test pins each monitoring region file. Since Story 69-5 the same guard also checks every
route file (`+page`, `+layout`, `+error`): see "Replaceable regions" below.

**Hash drift (Story 69-3):** the five monitoring `+page.svelte` files (endpoint list, add and detail, status
page admin, public status page) and the public status `+page.server.ts` changed, and `inject-behavior.ts`
gained the `skipInjectedLoads` marker, so a pack that overrides one of them sees its `hostSha256` drift with
the next web-host release; reconcile it with `pv-compose --accept-host`.

**Hash drift (Story 69-1):** the dashboard page, the project page, the project layout, `ProjectNav`,
`PageAlertBanner` and `DashboardPlaceholderGrid` changed, so a pack that overrides one of them sees its
`hostSha256` drift with the next web-host release; reconcile it with `pv-compose --accept-host`.

### Replaceable regions (Epic 69, Story 69-5)

M4 replaces a module by its resolved path, and a route file is overridden whole (M1), so a page region is only
replaceable once its markup lives in its own `.svelte` file under `src/lib/components/<area>/`
(`component-index.json` indexes that directory). Story 69-5 decomposed every PV route file that way. Two route-file
rules of the shipped `monolithic-region` guard keep it true; neither has an allow-list, a baseline or a suppression
syntax, and both skip files the lock records as CM's:

- **R1, no unmarked top-level content.** Every top-level template node of a route file is inside an `@region` or is a
  component use or a `{@render}`. "Top-level" descends through root `{#if}`, `{#each}`, `{#await}`, `{#key}` and
  `<svelte:boundary>` branches and through layout wrappers (an element with no direct text, only
  `class`/`id`/`style`/`role`/`data-*`/`aria-*` attributes and covered children). `<svelte:head>`, comments,
  `{#snippet}`, `{@const}` and `<InjectionPoint>` are ignored. A route file holding nothing but points fails too.
- **R3, no top-level component use outside a region (Story 69-6).** In a route file a top-level component use
  (`<Foo />`, `<Foo.Bar />`, `<svelte:component>` or `{@render}`) is a finding unless it is itself the marked region
  or the component it names hosts an `@region` of its own (the 69-1..69-4 pattern: a region component hosts its
  regions). R1 let a bare use through because it can be replaced; R3 closes the gap that left it without an injection
  point. A marked region that is only a `{@render}` is a finding too, since it holds no component of its own. R3
  is a pure addition to the shipped guard: it can only fail more files, so a composed host that ran the guard before
  can fail after a web-host upgrade for a file of its own that is not in the lock (provenance is the only exemption).
- **R2, thin region shell.** Inside a marked region of a route file only components, `<InjectionPoint>`, `{@render}`,
  `{#if}`/`{#each}`/`{#key}`/`{#await}` blocks around those, and elements that hold them (no text, no form control, no
  handler, bind or action) are allowed. The markup belongs in the component.

**The measurable 100 % (Story 69-6).** `pnpm check-injection-point-coverage` prints and enforces the figure
`coverage: R/R regions with a point, U/U top-level uses in a region, P/P pages with the 3 standard points = 100%
(N route files, E composition-lock exempt)`. It is computed from the same parses as the checks (the use count comes
from the R3 scan of the shipped guard), has no stored baseline, and exits 1 below 100 %. The route-render oracle's
census sentence ("covers every one of the N route files") must exist and agree with the tree, so deleting a route
file together with its region cannot keep the figure at 100 %. A `<InjectionPoint>` inside a `{#snippet}` the file
never renders, or behind a literal-false `{#if}`, does not count as rendering its point (it is reported as dead).
`pnpm check-route-regions --print` also lists every top-level use (`covered` or `UNCOVERED`) and reports every region
component of more than 60 non-blank template lines (`OVERSIZE`): a section a CM author cannot inject between. The
report is advisory while `OVERSIZE_ENFORCEMENT` (one constant in `scripts/lib/route-regions.ts`, no component list) is
`false`; the batch stories 69-10..69-12 split the 38 components and the last one turns it on.

**Shape.** The route file keeps the marker, the point and the data; the component keeps the markup and the logic only
that region uses:

```svelte
<!-- @region settings.home.header -->
<SettingsHomeHeader>
  <InjectionPoint name="settings.home.header" data={data?.__inject} />
</SettingsHomeHeader>
```

The component renders `{@render children?.()}` (after its markup, or before it when it is the last child of its parent,
so whitespace at the edge of the parent is unchanged). Pages whose state is shared by several regions keep the state in
the route file and pass it as props; a region that owns its state carries it. An error page has no behavior host, so its
region points are registered as `standard` points.

**Finding a region.** `pnpm check-route-regions --print` prints one row per region (route file, scope, region, region
component, point, inline lines, component lines, `@pv-stable` mark, status) derived from the tree, and fails when a route
file has no region, a region has no registered point, or its component is outside `src/lib/components`. Nothing is
committed: the table is regenerated on demand. `@pv-stable` stays a signal only; no region component carries it yet.

### Region points of the remaining top-level uses (Epic 69, Story 69-6)

Every top-level component use of a route file is its own region with a registered point (R3). 21 wrapper components
under `$lib/components` (the `shell`, `auth`, `vault`, `platform`, `settings`, `monitoring` and `status-page` folders)
render the original UNCHANGED and host the page's point as their `children` snippet (no DOM node, so PV's output is
byte-identical, pinned by the render oracles): `app.layout.search`, `project.layout.content`, `root.layout.progress`,
`auth.layout.brand`, `auth.register.form`, `vault.home.gate`,
`platform.home.{operator-notice,warnings,nav-cards}`, `settings.home.nav-cards`, `settings.security.enrollment`, the
five back links `settings.{audit-access-report,audit-forwarding,language,themes,users-erasure-detail}.back`,
`project.{certificates,domains,services}.list-header`, `project.status-page.error` and
`project.service-endpoints-detail.back`. Their props are the original component's props passed through (an M4
contract, not `@pv-stable` yet); `GlobalSearch` keeps its `@pv-stable` mark and its `open` binding goes through
`AppLayoutSearch` unchanged. A region inside a branch (the platform operator notice, the status page error alert) has
its point inside that branch, so it renders only for the caller who sees the region, and a contribution load obeys the
Story 69-7 denial skip. The tables of every area's points are generated, never typed: `pnpm check-route-regions
--print` (regions and top-level uses, from the tree) and `manifests/injection-points.json` (every point with its
`propsType`, `scope` and `hostRoutes`).

**Inner points under an M4 replacement.** A region point that PV renders as the `children` of a region component
(or inside it) lives and dies with that component. A replacement that wraps the original through `pv-original:` and
forwards `children` keeps every inner point; a full replacement that does not render the original or its `children`
drops them, and a fill at such a point does not render. `injection-points.json` still lists the point with its host
file (and `hostRoutes`), so the drift is explicit in the manifest rather than silent, and the kit never fails a
compose for an inner point whose host was replaced (the page still builds). The mock UI pack proves both
(`m3-phase6-region-points.spec.ts`).

**Pre-auth pages.** A contribution whose `load` throws fails the whole page (`injection "<point>" load failed:
<ErrorName>`, the 68-4 contract), and on `(auth)` and the vault page that includes sign-in. Keep fills on pre-auth
points render-only (no `load`) unless the load can never throw.

**Hash drift (Story 69-6):** the route files that gained a region (the pages and layouts above) changed, so a pack
that overrides one of them sees its `hostSha256` drift with the next web-host release; reconcile it with
`pv-compose --accept-host`. Version rule: R3 and the new points ship inside `@project-vault/web-host` (the guard, the
route files, `injection-points.json`), a published guard that fails more files plus a larger manifest, so the next
release of web-host is a MINOR bump; the kit's own contract and exports did not change.

### Region points (Epic 69, Story 69-4)

Beyond the three standard points of a page, a region point (`kind: 'region'`, named
`<area>.<page>.<region>`) sits inside one region of a page. Phase 5 adds 17 of them on three pages. All have
`scope: 'page'` (their `load` and `actions` work with no opt-in), because each `<InjectionPoint>` is rendered in the
route's `+page.svelte`, never inside a `$lib` component (a point in a component is `scope: 'component'` and its
behavior is inert).

**Pattern.** `<!-- @region <name> -->` precedes either (a) the region's container element in the page, holding the
extracted PV component and the point as siblings (`<div class="card"><XPanel /><InjectionPoint .../></div>`), or
(b) an extracted component that renders an optional `children` snippet last, with the point as its child. The
component is replaceable through M4 and the point survives that replacement, because it is page code. Points are
additive: PV's default always renders and there is no `fallback` mode. The page keeps its data and callbacks; a
region component's props are an M4 contract and are not `@pv-stable` yet (Story 69.5 decides).

**Props are least-data.** A point receives what PV already loaded and renders for that role. An ungated region
(members `header`, `notice`, `invite`; audit `header`, `notice`, `navigation`; notifications `header`) gets role and
flag fields only; a gated region gets its rows only inside PV's own gate. A contribution `load` does NOT run for a caller
PV's own load denied (Story 69-7, below), but a fill MUST still authorize on its own (defense in depth): read through
`event.fetch` and return nothing on 401/403/404. Layout-scope loads are not covered by a denied PAGE (SvelteKit runs
layout and page loads concurrently), and injected form actions never see the load result and still run for a denied
caller.

| Page                            | Points                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/settings/audit`               | `settings.audit.header`, `.notice`, `.navigation`, `.error`, `.search`, `.results`, `.export`, `.verify` |
| `/settings/notifications`       | `settings.notifications.header`, `.channels`, `.routing`, `.test`                                        |
| `/projects/[projectId]/members` | `project.members.header`, `.access`, `.notice`, `.invite`, `.invitations`                                |

The registry builds them with `regionPoints('<propsType>', [], [...names])`, which the coverage guard reads like
`pagePoints`. The mock UI pack fills six of them (`m3-phase5-region-points.spec.ts`).

**Hash drift:** this change adds injection points and server calls to about 70 PV route files, so the hash of
every file a pack overrides there changes with the next web-host release. That is the intended signal;
reconcile it with `pv-compose --accept-host`.

## Hooks, header policy and protected paths

Story 68-6 (design §8). A pack contributes to every SvelteKit hook without replacing PV's hooks
files, changes PV's security-header policy through the same contribution, and gets its `(app)`
routes protected like PV's. A full-file override of `src/hooks.server.ts`, `src/hooks.ts` or
`src/hooks.client.ts` stays allowed (M1); contributions are the normal path, not the only one.
Nothing here limits what a pack may contribute: every validation is integrity only.

### Wiring

```ts
// pv-ui.manifest.ts
hooks: { server: './hooks.server.ts', universal: './hooks.universal.ts', client: './hooks.client.ts' },
protectedPaths: { add: ['/public-cm'], remove: ['/(app)/cm-area/callback'] },

// vite.config.ts and vitest.config.ts of the composed app
import { pvHooks } from '@project-vault/composition-kit/vite'
export default viteConfig({ plugins: [pvHooks({ appRoot })] }, { appRoot, composedRoot: appRoot })
```

`pvHooks()` (`enforce: 'pre'`) generates `virtual:pv-hooks/server`, `/universal` and `/client` from
`composition.lock.json`: each re-exports the materialized CM file's namespace as `hooks` (empty when
the pack has no such file), and the server module also exports the protected-path data. web-host
ships its own empty provider for PV's build, and it **refuses to build a composed tree without
`pvHooks()`** (`composed tree detected but pvHooks() from @project-vault/composition-kit/vite is not
in the plugin list`), so a composed image can never silently ship without CM hooks or derived
protection. In dev a change to the lock's hooks or protected-path contribution restarts the dev
server (SvelteKit caches the server hooks behind a module-level `init_promise`); `pvComposeDev`
then updates the composed tree incrementally, so files other plugins generated in it (Paraglide's
output) survive. The integration job proves it live: a CM `(app)` route added while `vite dev` runs
is gated by the hook without a manual restart.

The server hook file is materialized under `src/lib/server/_cm/**`, so Kit's own server-only guard
rejects a client import of it. Exports that are not hooks are ignored and noted (`hookLabel` is not a
SvelteKit server hook; not composed), a near miss gets "did you mean `handle`?", and a hook in the
wrong file (`reroute` in the server file) gets "move it to hooks.universal". If the pack also
overrides the hooks file a contribution targets, the contribution is not composed (a note says so).

### The contract: chain entry or `wrap`

Every hook is a chain entry ("CM first, then PV") or `{ wrap: (pv) => replacement }`. When neither
PV nor the pack defines a hook, the composed export is `undefined`, so SvelteKit's own default runs.
Entries are called as plain functions. A throw or rejection propagates exactly as from PV's own hook.

| Hook (file)                      | Chain entry                               | Chain semantics                                                           | `wrap` receives                    |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| `handle` (server)                | `Handle`, or `{ before?, after?, wrap? }` | `[...before, wrap ? wrap(pv) : pv, ...after]` with `sequence()` semantics | PV's handle                        |
| `handleFetch` (server)           | `HandleFetch`                             | CM runs; its `fetch` is PV's `handleFetch` bound to the real fetch        | PV's, or a passthrough             |
| `handleError` (server, client)   | `HandleServerError` / `HandleClientError` | CM then PV, both awaited; CM's result unless `undefined`                  | PV's, or one returning `undefined` |
| `handleValidationError` (server) | `HandleValidationError`                   | CM first; the first non-`undefined` result                                | PV's, or one returning `undefined` |
| `init` (server, client)          | `ServerInit` / `ClientInit`               | CM then PV, awaited in order                                              | PV's, or a no-op                   |
| `reroute` (universal)            | `Reroute`                                 | CM first; a string wins, `undefined` falls through to PV                  | PV's, or one returning `undefined` |
| `transport` (universal)          | `Transport`                               | `{ ...pv, ...cm }`; the same key on both sides fails at start-up          | PV's, or `{}`                      |

**Where `handle` entries run (Q10).** `before` entries run outermost, before PV: there is no
`locals.user` and no Paraglide locale yet, and they run for anonymous requests to protected paths
too. `after` entries run inside PV, after PV's redirects and immediately before Kit's `resolve`:
they see `locals.user` and `getLocale()`, and never run for a request PV redirected. `wrap(pv)`
replaces PV's handle in place. Three examples:

```ts
// 1. A request id on every response (before).
export const handle = {
  before: [
    async ({ event, resolve }) => {
      const response = await resolve(event)
      response.headers.set('x-request-id', crypto.randomUUID())
      return response
    },
  ],
}
// 2. Tenant-scoped data for signed-in users only (after).
export const handle = {
  after: [
    ({ event, resolve }) => {
      event.locals.tenant = tenantOf(event.locals.user)
      return resolve(event)
    },
  ],
}
// 3. Full replacement of PV's handle (wrap): call pv zero, one or several times.
export const handle = {
  wrap: (pv) => async (input) => (shouldSkip(input.event) ? input.resolve(input.event) : pv(input)),
}
```

PV composes `handle` with its own `composeHandles()`: Kit `sequence()`'s semantics (forward
pre-processing, reverse post-processing, innermost-first `transformPageChunk`, first-wins `preload`
and `filterSerializedResponseHeaders`) without Kit's request store, proven by a differential test
against the real `sequence()`. Two documented differences: no per-handle OpenTelemetry span, and
`getRequestEvent()` inside a handle returns the request-level event, not one passed through
`resolve(otherEvent)`.

**Error logging (Q7).** PV defines no `handleError`, so in PV's build Kit's default logs every
server error. Once a pack contributes `handleError`, that function is the export and Kit's default no
longer runs, as in any SvelteKit app that defines `handleError`. Re-add logging in your own entry if
you want it:

```ts
export const handleError = ({ error, status }) => {
  console.error(status, error)
}
```

### Header policy

PV's security headers are one data policy (`PV_HEADER_POLICY` in `$lib/security/header-policy.ts`):
`defaults` plus exclusive `rules` (the first matching rule's headers replace the defaults). A rule
matches `{ exact }`, a raw `{ startsWith }`, a Kit `{ routeId }` or a `{ test }` predicate. The
composition sets the resolved headers with **one** `event.setHeaders` call per request, before the
first handle. Kit applies `setHeaders` only to responses that went through `resolve`, so redirects a
handle returns carry no policy headers (as before 68-6).

A server hook file changes it with `export const headerPolicy = (pv) => ({ ...pv, ... })`. The
returned policy is final: it may add, change or remove rules and defaults. It is validated
(well-formed names and values: only RFC 9110 field-value characters, so no CR/LF/NUL, no other
control character and nothing above U+00FF; no `set-cookie`, unique rule ids, one matcher key) and
deep-frozen. It is **never refused**: `describeHeaderPolicyDelta(PV_HEADER_POLICY, composed)` records
every added, changed and removed header and rule (a `test` predicate rule is reported as
`(opaque match)`). PV's policy applies to CM UI exactly as to PV UI: no rule is keyed on where a
route came from.

- **`exact` and `startsWith` match the raw or the decoded pathname.** `event.url.pathname` keeps
  percent-encoding, while Kit decodes the path before it matches a route, so a rule matches when
  either spelling does: `/%63m-area/x` gets a `{ startsWith: '/cm-area/' }` rule and `/%68andoff`
  gets PV's handoff headers. The decoding is Kit's own (`decodeURI` around `%25`): `%2F` and other
  reserved escapes stay encoded, nothing is decoded twice (`/%2568andoff` matches no rule, and Kit
  routes it nowhere), and a malformed escape falls back to the raw pathname. A `{ test }` predicate
  receives the raw pathname. A `{ routeId }` rule matches however the URL is spelled. The frozen
  extension-panel branch (below) keeps its raw `startsWith` until 68-11.
- **Change headers through `headerPolicy`, not `event.setHeaders` in a handle:** a handle that sets a
  name the policy already set makes Kit throw `"<name>" header is already set` on that request.
- **Route-level `setHeaders` conflicts fail at start-up (Q2).** `/shares/[token]` and
  `/external-shares/[token]` set `Referrer-Policy` in their `load`. A policy that would also set
  `referrer-policy` there fails with a message naming the routes; exclude those paths in a rule, or
  override those pages (M1).
- **The legacy extension-panel CSP is outside the policy** (Nestor, 2026-10-02): paths under
  `/extensions/panels/` keep exactly their frozen panel headers, and no contribution reaches them,
  until Story 68-11 retires the panel.
- **Start-up failures are caught in CI.** web-host ships `composed-hooks-init.test.ts`, which runs
  every composition over the virtual modules (`checkComposedHooks`): a bad policy (including one
  without `rules`/`routeSetHeaders` arrays), a hook of the wrong shape, a `handle.wrap` that returns
  no function, a transport collision or a protected-path redirect loop fails the composed tree's
  test run before it can crash-loop a server.
- **Every header change is printed.** The same test prints one line per difference from PV's policy
  (`pv-compose: header policy: added defaults.x-cm-policy`, `... changed ...`, `... removed ...`), so
  CM's review sees each add, change and removal in the composed tree's test output. The kit cannot
  compute it at compose time: the policy is code that runs against PV's own policy. Nothing is
  printed when the policy is PV's.

### Protected paths

PV's protected prefixes are data (`PV_PROTECTED_PREFIXES`, segment-prefix: `/settings` covers
`/settings` and `/settings/...`). `isProtectedRequest` is the one gate, used by both the vault
readiness check and the anonymous redirect. A request is protected when its pathname matches a
prefix, when Kit's matched route id (with `(group)` segments removed) matches a prefix, or when the
route id is one the composer derived. The route-id test closes two bypasses: a `reroute` that maps an
unprotected URL onto a protected route, and a percent-encoded URL (`/%73ettings/...`), which Kit
decodes for matching but not in `event.url.pathname`.

The composer **derives the exact route id** of every CM route under `src/routes/(app)/` (an addition
or an override with a `+page.svelte` (including a layout-reset `+page@….svelte`), `+page.ts`,
`+page.server.ts` or `+server.ts`), so CM pages, their data requests, their form actions and their
`+server` endpoints are gated by the hook. That matters because Kit runs no layout load for
`+server` (nor `(app)/+layout.server.ts` for a layout-reset page) and runs a form action before
any load.
CM routes outside `(app)` are public by design and listed in a note.

- `protectedPaths.add` adds path prefixes; `protectedPaths.remove` removes a prefix (PV's or an
  added one) or a derived route id, for example an OAuth callback. Removing a PV prefix is allowed
  and noted prominently. An entry that matches nothing is a note.
- Integrity failures: an `add` entry not starting with `/`, containing `?` or `#`, or ending with `/`;
  the same entry in `add` and `remove`; any protected prefix or derived route that covers `/login`,
  `/register` or `/vault` (a guaranteed redirect loop).
- The lock records `contributions.protectedPaths = { add, remove, derived: [{ routeId, urlPattern }] }`.
  A lock written before 68-6 has no `derived` and is read as `derived: []`. Run with `--verbose` to
  print each derived route.
- **Remote functions are not gated by protected paths (Q9).** `$app/server` `query`/`form`/`command`
  are served under `/_app/remote/...` with no route id; call `requireUser(getRequestEvent().locals)`
  inside them.

An older web-host without `manifests/hooks-surface.json` keeps the 68-3 behaviour: the files are
materialized and the lock records them, with notes that hooks and protected paths are not applied.

## Navigation delta (M5)

Story 68-7 (ADR 0007 M5, design §7). Every PV navigation surface is data with stable ids, and a UI
pack changes it with a **delta**: operations per surface, applied in order inside PV's nav models.
It is a delta, not a snapshot: a PV nav item the pack never touches (including one a later web-host
adds) is inherited and shown until the pack changes it. Nothing narrows M5: every item, PV's own
included, can be added, removed, hidden, renamed, reordered, nested and replaced, and no id prefix is
required for the pack's own items.

### Surfaces

`web-host`'s `manifests/nav-ids.json` lists every surface (its renderer file and context keys) and
every PV item id (its surface, parent and whether it has a visibility condition). The surfaces are:

| Surface                                            | Where                                                                               | Context (`ctx`)                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| `primary`                                          | the primary nav (also the mobile nav)                                               | `user`, `hasUiPanelExtension`, `pathname`, `search` |
| `project`                                          | the project tab bar                                                                 | `projectId`, `orgRole`, `pathname`                  |
| `shell.brand`, `shell.utility`, `shell.mfa-banner` | the header brand link, the notifications bell, the MFA banner's settings link       | `hidePrimaryNav`, `unreadCount`, `bannerMessage`    |
| `account`                                          | the account menu (`account.sign-out` is an action)                                  | `user`                                              |
| `footer`                                           | the footer links (external)                                                         | none                                                |
| `settings.index`, `platform.index`                 | the section index cards (`label` + `description`)                                   | none                                                |
| `platform.settings.links`, `settings.audit.links`  | sub-section link rows                                                               | none                                                |
| `notifications.tabs`                               | the notifications status tabs (`query`: `?status=…`)                                | `status`                                            |
| `breadcrumbs`                                      | one tree; a page renders the path to its node (`<Breadcrumbs node="…">`)            | `node`                                              |
| `back`                                             | one back link per page (`<BackLink node="…">`, `<NavLink surface="back" node="…">`) | `projectId`, `credentialId`                         |
| `error.nav`, `auth.links`                          | the error page's way back, the auth pages' cross-links                              | `authenticated`                                     |

Every context also has `pathname`. Ids are a public contract named by meaning, not position: PV never
renames one (a rename is a removal plus an addition, listed under "Nav ids removed" in the web-host
changelog). Legacy `navItems` (Story 29.3, deprecated and frozen) still render after the delta-applied
items and are not addressable by a delta.

### Writing `nav.ts`

```ts
import { resolve } from '$app/paths'
import {
  defineNavDelta,
  hide,
  insert,
  move,
  relabel,
  remove,
  reorder,
  replace,
} from '@project-vault/composition-kit/nav'

export default defineNavDelta({
  primary: [
    insert({
      after: 'primary.projects',
      item: { id: 'cm.billing', label: () => t('billing'), href: () => resolve('/billing') },
    }),
    insert({
      parent: 'primary',
      item: { id: 'cm.ops', label: 'Ops', icon: OpsIcon, children: [] },
    }),
    move('primary.health', { parent: 'cm.ops' }),
    relabel('primary.secrets', () => t('vault')),
    reorder('primary', ['primary.projects', 'primary.dashboard']),
  ],
  project: [
    insert({
      parent: 'project',
      item: {
        id: 'cm.project-billing',
        label: 'Billing',
        href: (ctx) => resolve(`/projects/${ctx.projectId}/billing`),
      },
    }),
  ],
  'settings.index': [
    hide('settings.index.sso-domains'),
    relabel('settings.index.users', { description: () => 'Seats and roles' }),
  ],
  'shell.brand': [replace('shell.brand.home', { label: 'CentralizeMe', href: () => resolve('/') })],
  account: [
    insert({
      before: 'account.sign-out',
      item: { id: 'cm.account.billing', label: 'Billing', href: () => resolve('/billing') },
    }),
  ],
})
```

Wire `pvNav()` next to `pvHooks()` in the composed app's `vite.config.ts` and `vitest.config.ts`.
web-host refuses to build a composed tree without it. `nav.ts` renders in the browser too, so it must
not import server-only code (Kit's server-only guard fails the build).

| Op                                                          | Semantics                                                                                         | Problems (integrity only)                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `insert({ after \| before \| parent, item })`               | exactly one anchor; `parent` appends as the last child, `parent: '<surface>'` at the root         | no anchor or two; an existing id ("use replace"); an anchor that was removed |
| `remove(id)`                                                | the item and its subtree leave the tree                                                           | none (an absent id is a note: the desired state holds)                       |
| `hide(id)`                                                  | the item stays as an anchor for later ops; it and its subtree are not rendered                    | none (idempotent; an absent id is a note)                                    |
| `relabel(id, label \| { label, mobileLabel, description })` | replaces only the named labels                                                                    | an empty object; an absent id                                                |
| `move(id, { after \| before \| parent })`                   | detaches and re-attaches the subtree                                                              | moving into its own subtree; a parent that is an action                      |
| `replace(id, item)`                                         | keeps the id; keeps PV's children and `when` unless the replacement declares its own (Q5)         | a different `item.id`                                                        |
| `reorder(parentId, ids)`                                    | the listed children first, in order; the others (also future PV ones) keep their order after them | an id that is not a child; a duplicate                                       |

Rules:

- **Per surface (Q4).** An op names ids of its own surface; an id of another surface is a problem that
  names the owning surface. Moving an item across surfaces is a `remove`/`hide` in one plus an
  `insert` in the other.
- **Full tree, then the delta, then visibility.** Anchors resolve against PV's full tree, so an insert
  after an operator-only item lands after it for operators and in the same place for everyone else.
  PV's conditions (`primary.platform`, `project.endpoints`, `primary.extension-panel`) run after the
  delta; a moved PV item keeps its own; a CM item may carry its own `when`. A group with no visible
  children is not rendered (Q14).
- **Labels** are functions evaluated on every render, so CM's i18n (reading Paraglide's `getLocale()`)
  follows a no-reload locale switch; a plain string is rendered as is in every locale. Labels are
  escaped text, always.
- **Kinds:** `link`/`badge-link` hrefs must be same-origin paths from `resolve()`; an absolute
  `http(s)://` URL is kind `external` (opened like the footer links); an `action` needs `onSelect`; an
  icon is any Svelte component, and an icon-only item still needs a `label` (its accessible name).
- **Nesting** has no depth limit. Each surface has a nested form: disclosures (`<details>`) in the
  primary nav, the account menu, the footer, the link rows and the tab bars; nested card lists on the
  index pages; the tree itself for breadcrumbs; sibling links for back and auth links.
- **Hiding is not access control (design rule 4).** A hidden item's route still answers. Restrict
  access with protected paths and the API's authorization.
- **Runtime is total (Q7).** In production an invalid op, or a CM callback that throws, costs only that
  op or item; the page renders. In dev the first render throws with every problem.

### At compose time

With a web-host whose `nav-ids.json` has `delta: 1`, `pv-compose` reads `nav.ts` with the app's
TypeScript and records every string-literal id: `navIdsReferenced` (targets and anchors are operative,
the targets of `hide`/`remove` are not), `navIdsDeclared` (the ids the pack inserts) and the
informational `navIdsHost`. It **fails** an operative reference to an id web-host no longer has, an id
used under another surface, an inserted id that web-host now defines (rename yours or replace PV's),
and a syntax error in `nav.ts`. It **notes** each id that is new in web-host (inherited and shown), a
hidden or removed id that vanished, every id passed as a variable (with its position), a
`nav references: <n> literal, <m> not statically checked` count, and any change to `footer.github` or
`footer.license` (check the AGPL-3.0 §13 source-offer obligations; never refused). An older web-host
keeps the 68-3 behaviour: the file is materialized and a "nav delta not applied" note is printed.

### In CI

`web-host` ships `src/lib/navigation/composed-nav.test.ts`. Run over the composed tree (story 68-9), it
validates the real delta on every surface over the full context matrix, in `en` and `es`: any
integrity problem, a callback that throws or an empty label fails, also for ids the compose step could
not see. PV's own CI runs two guards: `check-nav-ids` (every PV nav item has a stable, unique,
well-formed id inside its surface) and `check-nav-surfaces` (every `<nav>` and `aria-current` in a PV
`.svelte` file lives in a registered surface renderer; a new nav surface is registered and rendered
from data, never exempted).

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
`contributions`, `injectionPointsUsed`, `injections`, `navIdsReferenced`, `apiRouteOverrides`, and the removals'
paths). `notes` and the removed files' hashes never fail it.

## The version tuple

`web-host`'s `manifests/compatibility.json` names the PV release, the `extension-api` version, the
kit version (`kitVersion`), the exact Kit, Svelte, Vite and TypeScript versions and the API image
tag. The composer compares the **installed** versions it resolves from the app root (never declared
ranges), `@project-vault/composition-kit`'s own installed version, the manifest's `host.pvRelease`,
and, with `--module-pack <dir>`, the module pack's `@project-vault/extension-api` (resolved from that
directory's `node_modules`). It also requires
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
  route and a deleted override. The main variant also serves the M3 mechanism from the packed `web-host` (an
  injected component with server data and a form action, a layout point and a `shell.head` meta) and proves an
  unknown injection point fails with the way out.
  Story 68-15 runs the M3 cases that need sessions, tenants and a browser in the same variant: the API stub
  serves `session=u1` and `session=u2` identities and org-owned projects; 20 interleaved requests assert
  per-caller isolation (SSR HTML and `__data.json`); an anonymous or failing-PV request leaves the injected
  load counter at 0; a contribution load running as one tenant gets the API's 404 for another tenant's
  project; each injected component sits only in its page's client chunk; and a real Chromium (installed by a
  CI step in that job) checks hydration (with an oracle that fails on diverging server HTML), a client
  navigation without a document load, and the theme rune re-rendering an injected component.

## Runtime route audit from the API image (no PV checkout)

Design 12 step 3a: prove that every route on your composed API is `secureRoute`-built or classified, with
Project Vault's own audit and without cloning Project Vault. The audit ships **compiled in the API image**
(`dist/scripts/runtime-route-audit.js`, started with plain `node`: no `tsx`, no dev dependency, no database,
no network, no secret). It is a supported, versioned interface of the image, pinned by the same tag as the
rest of your compatibility tuple.

1. Make your module pack resolvable from the image's `node_modules`. The stock `ghcr.io/nestormata/project-vault/api`
   image does not contain your pack: build your composed API image `FROM` the Project Vault image at the
   tuple's tag and install the pack into it (or use the pack's own image, which already is that).
2. Extract the classifications of the composed pack: `pv-verify --app <dir> --only classifications --out
classifications.json` (written by the kit, never by hand).
3. Run the audit, mounting the directory that holds the file read-only:

```bash
docker run --rm --network none -v "$PWD/audit:/audit:ro" <your-composed-api-image> \
  node dist/scripts/runtime-route-audit.js --extension <package> --classifications /audit/classifications.json
```

`--extension` is a bare package specifier resolvable from the image (a path or URL is a usage error);
`--classifications` is a file path inside the container. The container starts as root only long enough for
the entrypoint to drop to the `node` user, so the mounted directory and file must be readable by uid 1000
(mode `755` / `644`).

| Exit | Meaning                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every route is `secureRoute`-built or classified. Stdout holds the report (`route audit: PASS`).                                                                                                                                                              |
| `1`  | The audit failed (an unclassified route, a duplicate, a stale classification) or the extension did not load (`extension <pkg> did not load: <reason>`). Stdout holds `route audit: FAIL` and one `  - <failure>` line per finding, each naming `METHOD /url`. |
| `2`  | A usage or input error (unknown flag, `--extension` that is not a bare package, an unreadable or malformed classification file). Nothing is booted; stderr holds the message and the usage line.                                                              |

The report is sorted and holds no absolute path and no env value, so it is stable in CI logs. The audit
checks classification integrity only; it never decides which routes may be public. The checkout form
(`pnpm --filter @project-vault/api route-audit:runtime ...`) runs the same code through `tsx` and stays the
in-repository and development form. Project Vault's CI runs the shipped form against the mock UI pack on
every relevant PR (inside the required `Mock UI pack mechanism e2e` job), so it cannot rot.

## Mechanism e2e (mock UI pack)

Story 68.10 proves M1-M7 together against PV's own build with a mock UI pack
(`fixtures/mock-ui-pack`: the overlay tree under `ui-pack/` and the mock module pack under `module/`, loaded by
the real API through `VAULT_EXTENSIONS_PACKAGE`). It never contains real CentralizeMe code, a secret or a back
door, and every capability is exercised at the breadth of design section 12; the lists there are a floor, not a
ceiling. `make mock-ui-pack-compose` composes the pack onto the packed `web-host` in the kit's isolated consumer
(`scripts/lib/web-host/consumer-tarballs.ts` is shared with the kit integration test) and runs `pv-compose
--check`, `pv-verify --only guards` (including the monolithic-region guard and its CM-exemption proof),
svelte-check, the shipped unit tests, `vite build`, a boot against the API stub and the HTTP/CSS assertions for
M1, M2, M3 on public pages, M4 and M6. PV's own CM-free build is the control group
(`scripts/check-pv-cm-free-build.test.ts`: every `virtual:pv-*` module of the built output is empty, and PV's own
built server answers the committed `main` snapshot).

**This job is red after my PV change.** A changed PV file that the pack overrides, replaces or wraps means the pack
is updated in the same PR: that is the guardrail working, never a reason to skip, loosen or allowlist anything.
Manifest hashes are computed when the manifest loads, so a mere PV edit never needs a hash bump. A PV change that
makes a mechanism impossible is a design question for Nestor, not a pack edit.

`make mock-ui-pack-e2e` runs the whole mechanism e2e on the host: it builds the composed web image
(`fixtures/mock-ui-pack/docker/web.Dockerfile`, from the exported composed-app directory), boots it with a real
API carrying the mock module pack (`VAULT_EXTENSIONS_REQUIRED=true`) and a real database through
`scripts/e2e-stack.sh` with `E2E_STACK_FLAVOR=mock-ui-pack` (per-run host ports and compose project name), and
runs Playwright (`apps/web/e2e/mechanism/playwright.config.ts`: retries 0, traces off) with one spec file per
capability under `apps/web/e2e/mechanism/`. The CI job `Mock UI pack mechanism e2e` runs it with an in-workflow
path filter that fails open. It is a **required status check on `main`** (branch protection, since story 68-19) and its name is pinned by
`scripts/check-mock-ui-pack-e2e-wiring.test.ts`; the gate was proven to go red on a deliberately broken mechanism
and green on revert. M5 (navigation as data, story 68-7) is covered by
`m5-navigation.spec.ts` over the pack's `nav.ts`: every operation (add, remove, hide, rename, move, reorder,
replace), nesting (a pack group two levels deep and a child under a native item), an inherited project tab, on
thirteen surfaces (the footer and the error page are replaced by the pack's M4/M1 content, so the shipped
`composed-nav` test covers those), and an operation on an unknown id that is recorded, never a crash. A string
`relabel` changes only the label (the narrow-screen label keeps PV's text), and a one-node surface such as the
login links renders the node and its descendants, so a pack link there is a child of that node. The mutation
proofs run the same job over a deliberately broken copy of the overlay
(`MOCK_UI_PACK_OVERLAY_DIR=<copy of fixtures/mock-ui-pack/ui-pack>`, never set in CI): each break turns exactly its
capability's spec red. The fail-closed boot checks (`scripts/e2e-stack.sh fault [mode] [required]`,
`fault-optional`) show a route drift stops the API whatever `VAULT_EXTENSIONS_REQUIRED` says, and a load failure
is contained only with `VAULT_EXTENSIONS_REQUIRED=false`. PV's own native nav is pinned by
`scripts/web-host-consumer-fixture/pv-nav.main.json` (`check-pv-nav-snapshot.test.ts`): a PV nav change updates
the snapshot in the same PR.
