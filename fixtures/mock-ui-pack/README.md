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
   `src/app.html`, `static/favicon.png`, the `/status` route group, `shell/Footer.svelte`,
   `shell/ShellAccount.svelte`, `$lib/api/audit.ts` and `$lib/server/require-user.ts`. Swapping one for
   another is a one-line change in `ui-pack/pv-ui.manifest.ts`.
