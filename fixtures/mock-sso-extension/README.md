# @project-vault/mock-sso-extension

A self-contained, in-process mock external identity provider extension, built to exercise Story
14.3's `POST /api/v1/auth/sso/start/:providerName` → IdP → `POST /api/v1/auth/sso/callback/:providerName`
flow end-to-end in CI and by hand — **without ever standing up a real third-party IdP account**
(Okta, Auth0, etc.).

## What this is (and is not)

- It implements the `AuthStrategy` contract published by `@project-vault/extension-api` (Story
  14.1): `onAuthenticate(credential: string): Promise<AuthResult>`.
- `onAuthenticate()` makes **no outbound network call whatsoever**. It maps a small, fixed set of
  test-controlled credential strings directly to canned `AuthResult` values via an in-memory
  lookup table (`FIXTURE_IDENTITIES` in `src/index.ts`), simulating "the IdP already authenticated
  this user and handed back an assertion."
- There is **no real redirect-to-IdP / assertion-verification mechanic** here at all. Per Story
  14.3's Dev Notes judgment call #1, the `start` route only mints and stores a CSRF-style `state`
  value — building the actual authorization-redirect URL is out of scope for the locked
  `AuthStrategy` contract. This fixture's "simulated redirect" is just directly constructing the
  callback payload (`{ credential: '<fixture-id>' }`) that `onAuthenticate()` expects — it
  deliberately **bypasses** everything a real IdP redirect/assertion would normally involve.

## Fixture identities

| Credential string | `AuthResult.email`          | Intended scenario                                                                 |
|--------------------|------------------------------|------------------------------------------------------------------------------------|
| `linked-user`      | `linked-user@example.test`   | Pre-seed an `external_identities` row for this subject → expect a full session (AC-5). |
| `unlinked-user`    | `unlinked-user@example.test` | No pre-seeded link, no pending invitation → expect `403 account_link_required` (AC-7). |
| `invited-user`     | `invited-user@example.test`  | Pre-seed a pending `project_invitations` row for this email → expect auto-provisioning (AC-8). |

Any other credential string makes `onAuthenticate()` reject.

## Loading it

Point `VAULT_EXTENSIONS_PACKAGE` at this package's name (after building it, so `dist/index.js`
resolves):

```bash
pnpm --filter @project-vault/mock-sso-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-sso-extension pnpm --filter @project-vault/api dev
```

The API's boot sequence (`apps/api/src/app.ts` → `loadExtension()` → `wireExtensionAuthStrategy()`)
picks it up exactly like any other extension — `authStrategies` becomes `[local, test.mock-sso-extension]`.

## Manual QA

See `pnpm --filter @project-vault/api sso:qa` (or `apps/api/src/scripts/sso-qa.ts` directly) for a
scripted runbook that boots the API with this extension loaded, seeds the three fixture
identities' backing rows, and prints ready-to-run `curl` commands for each scenario.

## Production-safety

**This package's name must never appear in any production `EXTENSION_PATH`/`VAULT_EXTENSIONS_PACKAGE`
default, example config, or deploy manifest.** `apps/api/src/__tests__/mock-extension-not-in-production.test.ts`
enforces this with a repo-wide grep-based check.
