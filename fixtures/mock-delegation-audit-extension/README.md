# @project-vault/mock-delegation-audit-extension

A test fixture for Story 71.5, the real-host proof of Epic 71. It gives the isolated-stack journey
`apps/web/e2e/journeys/j36-delegated-audit-real-host.spec.ts` something to load into a real
`apps/api` process:

- `POST /api/v1/ext/mock-delegation/audit-events`: a **delegated** route
  (`security.delegation` with a `historicalActorPolicy` of one hour, `writeAuditEvent: false`, and
  a `capability` that this fixture's own gate can deny). Its handler forwards the request body
  (`eventType`, `resourceType`, `resourceId`, `payload`, `idempotencyKey`, `actorId`,
  `occurredAt`) to `host.auditEventSource.writeAuditEvent`, with the org taken from the verified
  assertion (`ctx.delegation.orgId`), never from the body. It answers `200 { data: receipt }`, or
  the host's typed error as `{ error: { name, code } }` (409 idempotency conflict, 422 attribution
  rejection, 500 anything else), never a message.
- `POST /api/v1/ext/mock-delegation/gate`: a delegated control route, `{ deny: boolean }`, that
  flips this fixture's capability gate for the calling org only, so the journey can prove the
  "capability disabled" denial on the real process.

Every verification (assertion, body hash, operation, replay burn, actor resolution, historical
admission) and every attribution decision is PV's, not this fixture's.

## Loading it

```bash
pnpm --filter @project-vault/mock-delegation-audit-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-delegation-audit-extension \
VAULT_HANDOFF_INSTANCE_ID=<instance id> VAULT_DELEGATION_VERIFY_KEYS='[{"kid":...,"publicKeyPem":...}]' \
  pnpm --filter @project-vault/api dev
```

The journey does this for you, with the test-only signer in
`apps/web/e2e/fixtures/delegation-test-key.ts`.

## Production-safety

**This package's name must never appear in any production `VAULT_EXTENSIONS_PACKAGE` default,
example config, or deploy manifest**
(`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` guards this). It is a
devDependency of `apps/api` only. Its image build argument, `INCLUDE_MOCK_DELEGATION_EXTENSION`,
defaults to `false` in every stage and no compose file sets it. The delegation test key and
instance id it is exercised with are guarded separately by `scripts/e2e-stack.test.ts`.

This is a test fixture, not a template. The authoring guide's delegated-routes section in
[`docs/extensions/authoring.md`](../../docs/extensions/authoring.md) documents the contract.
