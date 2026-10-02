# @project-vault/mock-api-routes-extension

A test fixture for Story 68.8 (M7 API routes). It exercises the `apiRoutes` manifest field and
hooks end to end, through PV's real `loadExtension()` and `createApp()`:

- added routes at any URL (an org-scoped `GET /api/v1/cm/documents`, a mutating `POST /cm/x`
  with PV's default audit, a public `POST /cm/webhooks/:provider` outside `/api/v1`, and routes
  that need MFA, a platform operator or a capability the fixture's own gate denies);
- a `wrap` of PV's `GET /api/v1/projects/:projectId` that extends the response schema, and an
  explicit `HEAD` override of the same route;
- overrides of raw PV routes (`GET /health`, the `GET /api/v1/auth/login` 405 stub, the
  swagger-ui `GET /api/v1/docs/yaml` route);
- `replaceSecurity` declarations that loosen (`GET /api/v1/dashboard`) and tighten
  (`GET /api/v1/capabilities`) a PV route.

Its schemas come from its **own** `zod` dependency, pinned to the line CentralizeMe's module pack
uses (`3.25.x`, imported through `zod/v4`), so PV's compilers are proven against a second Zod
instance.

## Scenarios

Tests pick a boot scenario with `setApiRoutesScenario()` before `createApp()`: `default`,
`missing-target`, `collision`, `bad-schema`, `above-host`, `never-refused`, `old-pack`. The
loader reads `default.manifest` and calls `default.hooksFactory()` at load time, so the
scenario must be set first. `observed` records calls for the integration tests.

## Production safety

This is a devDependency of `apps/api` only. It must never appear in a production env file,
deploy manifest or `VAULT_EXTENSIONS_PACKAGE` example
(`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` guards this). API tests import
it by a string specifier, never statically, so the API image needs only its `package.json` for
the frozen-lockfile install.

## Building

```bash
pnpm --filter @project-vault/mock-api-routes-extension build
```

This is a test fixture, not a template. The authoring guide's "API routes (`apiRoutes`)" section
in [`docs/extensions/authoring.md`](../../docs/extensions/authoring.md) documents the contract.
