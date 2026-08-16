# @project-vault/mock-envelope-extension

A self-contained, in-process mock "signed-envelope" identity extension, built to exercise Story
23.2's native-login-exclusion policy (`replacesNativeLogin: true`, the AC-4a proving latch, and
the full boot → login → restart → SSO-only login cycle) end-to-end in CI, in Playwright, and by
hand — **without a real third-party identity provider**.

Modeled loosely on CentralizeMe's signed-envelope ingestion pattern (this story's own motivating
example): a bearer credential is a compact, Ed25519-signed token (`header.payload.signature`,
via the `fast-jwt` library) carrying `sub`/`aud`/`iat`/`exp`/`jti` and an optional `email`/`role`.

## What this is (and is not)

- It implements the `AuthStrategy` contract published by `@project-vault/extension-api`:
  `onAuthenticate(credential: string): Promise<AuthResult>`.
- It declares `replacesNativeLogin: true` in its manifest (Story 23.2 AC-2) — loading it is what
  makes `replacementDeclared` true.
- `onAuthenticate()` makes **no outbound network call**. Signature verification uses this
  package's own committed, test-only Ed25519 keypair (`src/keys.ts`) — never a real IdP's key.
- The verification key, expected audience, and clock are all **injectable**
  (`createEnvelopeAuthStrategy({ getVerificationKey, expectedAudience, clock })`), specifically so
  the failure modes below are expressible in tests without a real network dependency.

## ⚠️ Warning: the burned-`jti` replay guard is process-local and proves nothing in production

`onAuthenticate()`'s replay defense (`src/index.ts`'s `burnedJti` — an in-memory `Set`) is
**single-process, in-memory, and reset on every restart**. It is sufficient for this fixture's own
tests and for a single local `pnpm dev` process, and it is **exactly wrong** for anything beyond
that:

- **Multi-worker / multi-replica deployments** (ADR 0003's sharded topology, or any ordinary
  Docker Compose deployment running more than one API process): each worker has its own `Set`, so
  the *same* signed envelope can be replayed once per worker before any of them notices.
- **A restart clears it entirely.** A captured, still-unexpired envelope is fully replayable again
  after any redeploy.

**A real extension implementing this contract MUST use a DB-backed atomic conditional write**
(`INSERT ... ON CONFLICT DO NOTHING`, exactly like this story's own
`apps/api/src/modules/auth/native-login-latch.ts` uses for its proving latch) keyed on `jti`, not
an in-memory structure. This is stated here, in the source comment on `burnedJti`, and in Story
23.2's own Dev Notes so nobody mistakes this fixture's shortcut for a production-ready pattern.

## Failure modes this fixture deliberately makes testable (AC-14/AC-15)

Every one of these is a dedicated test in `src/index.test.ts`, and every one results in the exact
same generic rejection (`EnvelopeRejectedError`, AC-15's uniform-rejection requirement — the
caller cannot distinguish *why* an envelope was rejected):

| Failure mode | How |
|---|---|
| Invalid signature | Tamper with the token's trailing bytes |
| Expired | Inject a clock past `exp` |
| `exp - iat > 60s` | Sign with an oversized declared lifetime — rejected even though not yet expired |
| Replayed `jti` | Present the same token twice |
| Concurrent replay | Present the same token from two simultaneous callers — exactly one wins |
| Wrong audience | Configure `expectedAudience` to not match the signed `aud` |
| `alg: none` | Hand-construct a token with an unsigned `none`-algorithm header |
| HMAC/algorithm confusion | Sign with `HS256` using the Ed25519 **public** key PEM as the HMAC secret |
| Missing required claims | Sign a token omitting `aud`/`jti`/`iat` |
| Malformed input | Feed non-JWT-shaped garbage |
| Untrusted role claim | Present a `role` outside the fixed allow-list (`['member']`) |
| Failed key fetch (simulated JWKS outage) | `getVerificationKey` throws |
| Wrong key | Sign with an unrelated Ed25519 keypair |

Each of these, driven through the real `resolveNativeLoginPolicy()`/latch machinery in
`apps/api`'s integration tests, leaves `replacementProven` unset and native login **enabled** —
this is AC-4a's whole reason to exist: no realistic production failure of the extension can lock
an operator out.

## Loading it

```bash
pnpm --filter @project-vault/mock-envelope-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-envelope-extension \
MOCK_ENVELOPE_EXPECTED_AUDIENCE=test-instance \
pnpm --filter @project-vault/api dev
```

## Manual QA / minting a credential

```ts
import { signFixtureEnvelope } from '@project-vault/mock-envelope-extension'

const credential = signFixtureEnvelope({ sub: 'demo-user', aud: 'test-instance' })
// POST it as { credential } to /api/v1/auth/sso/callback/test.mock-envelope-extension
// (after POST /api/v1/auth/sso/start/test.mock-envelope-extension to mint the state cookie).
```

## Production-safety

**This package's name must never appear in any production `VAULT_EXTENSIONS_PACKAGE` default,
example config, or deploy manifest.**
`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` enforces this for both fixture
extensions in this repo with a repo-wide grep-based check.
