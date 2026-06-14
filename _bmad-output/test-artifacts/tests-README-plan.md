# Test Framework — Planning Document

> **Status:** Pre-implementation planning artifact.
> This document specifies what the test framework will look like once the application is scaffolded.
> Copy or adapt this to `apps/web/tests/README.md` when the monorepo is initialized.

---

## Overview

Project Vault uses a three-layer test strategy across its TypeScript fullstack monorepo:

| Layer | Framework | Scope | Location |
|---|---|---|---|
| Unit / Integration | Vitest | Pure functions, modules, API handlers | Per-package `__tests__/` (per architecture) |
| E2E / UI | Playwright | Full user flows against running app | `apps/web/tests/e2e/` |
| Contract (CDC) | Pact.js + Vitest | Web → API interface contract | `apps/web/tests/contract/` |

This README covers the Playwright E2E layer and Pact consumer CDC layer.

---

## Prerequisites

```bash
# From monorepo root
pnpm install

# Install Playwright browsers (run once, or after playwright version bumps)
pnpm --filter web exec playwright install --with-deps
```

Required environment variables (copy `.env.example` → `.env` in `apps/web/`):

```bash
TEST_ENV=local
BASE_URL=http://localhost:5173   # SvelteKit dev server
API_URL=http://localhost:3000    # Fastify API
```

---

## Running Tests

### E2E Tests (Playwright)

```bash
# From monorepo root
pnpm --filter web test:e2e              # Headless, all browsers
pnpm --filter web test:e2e:ui           # Playwright UI mode (visual debugger)
pnpm --filter web test:e2e:headed       # Headed Chrome
pnpm --filter web test:e2e:debug        # Debug mode (pauses on failure)

# Run specific file or grep
pnpm --filter web test:e2e -- tests/e2e/auth/login.spec.ts
pnpm --filter web test:e2e -- --grep "should create a secret"

# Via Turborepo (runs after build)
pnpm turbo test:e2e
```

### Consumer Contract Tests (Pact)

```bash
# Run consumer contract tests (generates pact files in apps/web/pacts/)
pnpm --filter web test:pact:consumer

# Publish pact files to broker (requires PACT_BROKER_BASE_URL + PACT_BROKER_TOKEN)
pnpm --filter web publish:pact

# Check deployment safety
pnpm --filter web can:i:deploy:consumer

# Record deployment (main branch only)
pnpm --filter web record:consumer:deployment
```

---

## Architecture

### E2E Layer

```
apps/web/tests/
├── e2e/
│   ├── auth/
│   │   ├── login.spec.ts          # Standard + SSO login flows
│   │   └── mfa.spec.ts            # TOTP MFA flows
│   ├── secrets/
│   │   ├── create-secret.spec.ts  # Create, version, tag secrets
│   │   ├── view-secret.spec.ts    # Reveal, copy, audit trail
│   │   └── rotation.spec.ts       # Manual + automated rotation flows
│   └── rbac/
│       └── permission-gates.spec.ts  # Role-based UI gating
└── support/
    ├── fixtures/
    │   └── index.ts               # mergeTests composition — import test from here
    ├── helpers/
    │   ├── auth.ts                # reusable login/logout, MFA setup
    │   ├── secret.ts              # CRUD shortcuts via API
    │   └── network.ts             # SSE capture, network interception
    ├── factories/
    │   ├── secret.factory.ts      # buildSecret(overrides)
    │   ├── user.factory.ts        # buildUser(overrides)
    │   └── org.factory.ts         # buildOrg(overrides)
    └── page-objects/
        ├── LoginPage.ts
        ├── SecretsListPage.ts
        └── SecretDetailPage.ts
```

**Always import `test` from `../support/fixtures/index.ts`**, not directly from `@playwright/test`. This gives access to all composed fixtures.

```typescript
// ✅ Correct
import { test, expect } from '../support/fixtures';

// ❌ Wrong — misses project fixtures
import { test, expect } from '@playwright/test';
```

### Contract Layer

```
apps/web/tests/contract/
├── consumer/
│   ├── secrets-api.pacttest.ts    # Secrets CRUD contract
│   ├── auth-api.pacttest.ts       # Auth endpoints contract
│   └── rotation-api.pacttest.ts  # Rotation endpoints contract
└── support/
    ├── pact-config.ts             # PactV4 factory (consumer: project-vault-web, provider: project-vault-api)
    ├── provider-states.ts         # Provider state factory functions
    └── consumer-helpers.ts        # Local shim for createProviderState, setJsonBody, setJsonContent
```

Consumer: **`project-vault-web`** · Provider: **`project-vault-api`**

Contract tests use the `.pacttest.ts` extension (not `.spec.ts`). They run via a dedicated `vitest.config.pact.ts` that runs independently of the unit test suite.

---

## Best Practices

### Selectors

Prefer `data-testid` attributes for stability. Do not select by CSS class or text unless you own the component.

```typescript
// ✅ Stable
await page.getByTestId('secret-name-input').fill('DB_PASSWORD');

// ⚠️ Fragile — breaks on refactor
await page.locator('.secret-form input:first-child').fill('DB_PASSWORD');
```

### Test Isolation

Each test must be fully isolated. Use API-level setup (via `apiRequest` fixture) to create test data, and assert cleanup in `afterEach` or via `auto: true` fixtures.

```typescript
test('should reveal a secret value', async ({ apiRequest, page, recurse }) => {
  // Seed via API — faster and more reliable than UI setup
  const { body: secret } = await apiRequest({
    method: 'POST',
    path: '/api/projects/test-project/secrets',
    body: buildSecret({ name: 'TEST_SECRET' }),
  });

  await page.goto(`/projects/test-project/secrets/${secret.id}`);
  await page.getByTestId('reveal-secret-btn').click();
  await expect(page.getByTestId('secret-value')).toBeVisible();
});
```

### Multi-Role Auth

Use the auth fixture for role-based session persistence. Store state in `tests/support/.auth/` (gitignored). This avoids login UI overhead in every test.

```typescript
// tests/support/fixtures/auth.fixture.ts
// Roles: 'admin', 'editor', 'viewer'
// Usage: test('...', async ({ adminPage, viewerPage }) => { ... })
```

### Network Interception

Use `interceptNetworkCall` fixture to assert API calls triggered by UI actions. Avoid relying on UI state alone for assertions about API interactions.

### SSE / Real-time

For tests involving SSE (rotation status updates, health checks), capture the SSE stream before triggering the action, then assert the event arrives:

```typescript
// helpers/network.ts provides sseCapture() helper
const sseStream = await sseCapture(page, '/api/events');
await triggerRotation(page, secretId);
await expect(sseStream).toHaveReceivedEvent('rotation.completed');
```

---

## CI Integration

### E2E Workflow

Playwright runs in CI on pull requests and `main` pushes. Tests shard across 4 workers. Artifacts (traces, screenshots, HTML report) are uploaded on failure.

```yaml
# .github/workflows/e2e.yml (summary)
- Run: pnpm --filter web test:e2e
- Shard: 4 workers
- Artifacts: playwright-report/ on failure
- Browsers: chromium, firefox, webkit
```

### Contract Workflow

Consumer CDC tests run on PRs and `main` pushes. After test run, pacts are published to PactFlow. Provider verification is triggered via webhook. `can-i-deploy` gates deployment on `main`.

```yaml
# .github/workflows/contract-test-consumer.yml
1. Detect Pact breaking change (PR checkbox)
2. Install dependencies
3. Run consumer contract tests → generate pact files
4. Publish pacts to PactFlow
   → PactFlow webhook triggers provider verification
5. [main only] Can I deploy? (waits for provider result)
6. [main only] Record deployment
```

The `detect-breaking-change` composite action reads a `[x] Pact breaking change` checkbox from the PR description body. Check this when intentionally changing a contract.

---

## Dependencies to Install

When the monorepo is initialized, add to `apps/web/package.json` devDependencies:

```bash
# E2E
pnpm --filter web add -D @playwright/test @seontechnologies/playwright-utils @faker-js/faker

# Contract testing
pnpm --filter web add -D @pact-foundation/pact @seontechnologies/pactjs-utils vitest

# Pact CLI (for broker scripts)
pnpm --filter web add -D @pact-foundation/pact-standalone
```

> **Note on `@seontechnologies/pactjs-utils`:** If not yet published, use the local consumer-helpers shim in `tests/contract/support/consumer-helpers.ts` (already specified in this plan). The shim mirrors the published API exactly — swap the import when the package is available.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `browserType.launch: Executable doesn't exist` | Playwright browsers not installed | `pnpm --filter web exec playwright install` |
| `Error: page.goto: net::ERR_CONNECTION_REFUSED` | Dev server not running | Start with `pnpm dev` or set `reuseExistingServer: false` |
| Pact test timeout | Mock server startup slow | `testTimeout: 30000` already set in `vitest.config.pact.ts` |
| `PACT_BREAKING_CHANGE` not set in CI | `detect-breaking-change` step missing | Verify it runs before `npm ci` in the workflow |
| Flaky test on SSE assertion | Race: event arrives before listener | Use `sseCapture()` before triggering action (see above) |

---

## Knowledge Base

This framework was generated using the TEA (Test Architect) knowledge fragments:

- `overview.md` — `@seontechnologies/playwright-utils` fixture patterns
- `fixtures-composition.md` — `mergeTests` composition
- `auth-session.md` — Multi-role session persistence
- `api-request.md` — API fixture for seeding
- `recurse.md` — Polling for async/background jobs
- `network-error-monitor.md` — HTTP error auto-detection
- `intercept-network-call.md` — Network interception
- `data-factories.md` — Faker factory pattern
- `pact-consumer-framework-setup.md` — Full CDC consumer setup
