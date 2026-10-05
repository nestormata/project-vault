# @project-vault/mock-ui-pack

A test fixture for Story 68.10: a mock, CentralizeMe-shaped product that composes onto PV's own web
app and API so PV's CI proves the composition capabilities **M1-M7 together**, on a composed image,
against a real API and database. It is never published and never reaches a production image or an
env file. It contains no real CentralizeMe code, no copy of a CM file, no secret and no network call
to anything but the stack under test.

| Part        | Where                                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI pack     | `ui-pack/`                                      | `pv-ui.manifest.ts` (`defineUiPack`) and its overlay: page, layout, error, `app.html`, static and hooks overrides (M1), new routes at any path and protected-path deltas (M2), injections with a load and an action (M3), component and module replacements through `pv-original:` (M4), the nav delta `nav.ts` (M5), `theme.css` (M6) and message overlays. Read by `pv-compose --pack`; typechecked only inside the composed tree, so it is not part of the workspace `tsc` or `eslint`. |
| Module pack | `module/`                                       | The M7 half: an extension package (`manifest.apiRoutes` plus `hooksFactory`), built with `tsc` to `dist/` and loaded by the REAL API through `VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-ui-pack`. Uses the shipped `@project-vault/extension-api` contract only.                                                                                                                                                                                                                        |
| Image       | `docker/web.Dockerfile`, `docker/.dockerignore` | The composed web image. The build context is the composed app directory exported from the isolated consumer (packed tarballs under `./tarballs`, never `apps/web`, never a monorepo path). This is the pattern CentralizeMe copies.                                                                                                                                                                                                                                                        |

## Region points (Story 69.1)

Two M3 fills target **region points** (points inside a shared PV component) and opt in to behavior with
`hostRoutes` (Q12 option B):

- `project.detail.tiles` on PV's NATIVE project page (`injections/ProjectTile.svelte`, a load and an action,
  `hostRoutes: ['/(app)/projects/[projectId]#page']`). The load returns ids and a status only; the action reads
  the project with the member's own session first (RLS), so a foreign or missing id writes nothing.
- `dashboard.home.activity` inside the pack's own dashboard OVERRIDE: the override imports PV's
  `RecentActivitySection`, the way CentralizeMe's override builds on PV's region components, and keeps its
  `withInjectedLoad` call, which is what makes the opted-in load run. The one-project 303 auto-skip is CM's
  rule on its override and is not implemented in PV.

## Credential detail regions (Story 69.2)

Three M3 fills target **region points of PV's NATIVE credential detail page** (the pack does not override it) and
opt in with `hostRoutes: ['/(app)/projects/[projectId]/credentials/[credentialId]#page']`:

- `credential.detail.actions` (`injections/CredentialActionsFill.svelte`, action `?/credential.detail.actions.note`):
  a control in the header card's action cluster for every role. The action reads the credential and the project
  with the member's own session first (RLS), decides the caller's project role from THAT answer (a viewer gets
  `fail(403)`; a forged `projectRole` form field is ignored), then writes through the pack's `/api/v1/cm/documents`
  route, which writes the one audit row.
- `credential.detail.shares` (`CredentialSharesFill.svelte`, `credential-shares.server.ts` load,
  `?/credential.detail.shares.probe` action): renders at the end of the Shares section. The load returns ids, a
  status and a per-load nonce only. The probe calls the rate-limited `GET /api/v1/cm/limited`, so a 429 reaches the
  action result and the page re-renders with a fresh load.
- `credential.detail.metadata` (`CredentialMetadataFill.svelte`): a tile inside PV's metadata `<dl>`.

The pack replaces no credential region component on purpose: PV's own page tests run over the composed tree
(`excludedPvTests` only excludes a test whose subject was replaced, and the subject walk stops at a route), so a
replaced region would turn PV's own credential page tests red. The two-level Shares design (replace the INNER
`CredentialSharesNative`, keep the fill in the OUTER `CredentialSharesRegion`) is therefore proven at index level
by `scripts/lib/web-host/credential-regions-index.test.ts`. The spec is
`apps/web/e2e/mechanism/m3-credential-injection.spec.ts`; the helpers `createCredential` and `seedProjectViewer`
(a project viewer through PV's real invitation flow) are in `apps/web/e2e/mechanism/fixtures.ts`. A sealed vault
cannot be produced in the shared stack without breaking other specs, so that case is proven at unit level and in the
kit integration job against the API stub (`c-sealed`).

## Monitoring region points (Story 69.3)

Four M3 fills target region points of the endpoint, status page admin and public status routes (PV's own pages, not
overridden by the pack):

- `project.service-endpoints-detail.history` (`injections/EndpointHealthTile.svelte`, a load and an action,
  `hostRoutes: ['/(app)/projects/[projectId]/service-endpoints/[serviceEndpointId]#page']`). The load returns ids
  and a status only; the action reads the endpoint with the member's own session first (RLS), so a foreign or
  missing id writes nothing, and then writes one audit row through the pack's module route.
- `project.service-endpoints.row` (`injections/EndpointRowPill.svelte`, component only: the "no opt-in" shape).
  The point renders once per row INSIDE the Monitoring cell, with `props.endpoint` as the only per-row input.
- `project.status-page.services` (`injections/StatusServicesTile.svelte` and a load,
  `hostRoutes: ['/(app)/projects/[projectId]/status-page#page']`). The region renders only for a caller who
  can manage the page; the load reads the status page configuration (which holds the public token) and returns
  the project id and an API status ONLY.

- `status.detail.services` on the ANONYMOUS public status page (`injections/StatusPublicTile.svelte` and a load,
  `hostRoutes: ['/status/[token]#page']`). The load runs only for a valid token (an invalid, disabled or sealed
  token skips every contribution load), without `locals.user`, and returns a run counter and a literal only. Region
  data on a public page must be public-safe: its result is serialized into public HTML and `__data.json`.

The M1 removal case now removes `/external-shares` (PV answers `/external-shares/<token>` with a 200 "not found"
page, so the 404 still proves the removal) so that `/status/<token>` keeps serving.

## No back doors

The pack never bypasses authentication or tenancy to make a case pass: it reads data through the
contract's `ctx.tx` and through PV's own authenticated `event.fetch`, never a client of its own. The
one fault knob, `MOCK_UI_PACK_BOOT_FAULT=missing-target`, can only make the module **fail** to boot
(a wrap of a PV route that does not exist), so the API's `VAULT_EXTENSIONS_REQUIRED=true` fail-closed
path is provable. It appears only in `docker-compose.mock-ui-pack.yml` and this package
(`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` pins that).

## Running it

```bash
make mock-ui-pack-compose   # compose stage only: pv-compose --check, pv-verify, svelte-check, build, HTTP/CSS
make mock-ui-pack-e2e       # the whole thing: compose, composed image, real API + database, Playwright
make mock-ui-pack-e2e SPEC=e2e/mechanism/m7-api-routes.spec.ts   # one capability (no `--`)
E2E_STACK_KEEP=1 make mock-ui-pack-e2e   # leave the stack up (the project name and ports are printed)
```

`make mock-ui-pack-e2e` is host-side (the `make ci` container has no Docker CLI), needs Docker and
the public npm registry, and prints one named stage at a time: `Pack`, `Compose`, `Build composed
image and boot stack`, `Mechanism e2e`, `Teardown`. The stack uses per-run host ports and a per-run
compose project name (`pv-mock-ui-pack-<random>`), so two runs, or a run beside `make e2e`, never
collide. The Playwright specs are `apps/web/e2e/mechanism/m<N>-*.spec.ts`, one file per capability,
each with a positive (`works`) and a failure (`fails`) case.

## "This job is red after my PV change"

The job is named **Mock UI pack mechanism e2e**. It goes red when a PV change breaks something the pack
overrides, replaces, wraps or injects into. That is the guardrail working, never a reason to skip,
loosen or allowlist anything:

1. Read the failing stage in the check list (`Compose`, `Build composed image and boot stack`,
   `Mechanism e2e`) and, for the last one, the failing capability file (`m1`..`m7`) in the test name.
2. If a PV file the pack targets changed, update the pack **in the same PR**. Manifest hashes are
   computed when the manifest loads, so a mere PV edit never needs a hash bump; a moved file fails with
   its path named.
3. If the PV change makes a mechanism impossible, that is a design question for Nestor, not a pack edit.
4. Candidate PV targets were chosen for stability (files a PV PR rarely touches): the dashboard page and
   its load, the recovery page and its load, the `(auth)` layout, `+error.svelte`, `src/hooks.server.ts`,
   `src/app.html`, `static/favicon.png`, the `/external-shares` route group, `shell/Footer.svelte`,
   `shell/ShellAccount.svelte`, `$lib/api/audit.ts` and `$lib/server/require-user.ts`. Swapping one for
   another is a one-line change in `ui-pack/pv-ui.manifest.ts`.
