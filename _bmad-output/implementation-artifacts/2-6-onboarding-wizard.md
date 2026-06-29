# Story 2.6: Onboarding Wizard

Status: review

<!-- Ultimate context engine analysis completed 2026-06-28 — comprehensive developer guide for the first-run onboarding wizard. This story adds: (1) the `user_onboarding` table tracking per-user-per-org wizard completion state, (2) `GET/POST /api/v1/users/me/onboarding` endpoints gated behind SecureRoute, (3) the three-step bypass-proof `OnboardingWizard` Svelte component that overlays the full app shell, and (4) a SvelteKit layout-level guard that intercepts first-time users before they can reach any other route. Relies on: Story 2.0 (web shell, auth guard), Story 2.1 (projects table, project creation), Story 2.2 (credential create + encrypt path). Produces: no downstream data dependencies — it is a one-time UX gate. -->

## Story

As a new user accessing the web UI for the first time after creating an account,
I want a guided onboarding wizard that teaches me the project-centric organization model and walks me through adding my first real credential,
so that I understand the vault's mental model and can place secrets confidently before working independently.

*Covers: FR9, UX-DR1.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.6-Onboarding-Wizard`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.0 (MVP frontend shell + auth guard) is merged | The wizard overlays the `(app)` layout — the auth/session guard in Story 2.0 must already be present so the wizard can only render for authenticated users |
| Story 2.1 (`projects` + `project_memberships` tables, project creation API) is merged | The wizard gate checks "has the user already created or been added to a project in this org?" as part of its initial UX flow; the `projects` table FK must pre-exist |
| Story 2.2 (`credentials` + `credential_versions` tables, `POST /api/v1/projects/:projectId/credentials`) is merged | Step 2 of the wizard submits a real credential using the credential creation endpoint from Story 2.2; without it, there is no endpoint to call and no schema to validate against |
| Migration numbering: verify `meta/_journal.json` | ⚠️ The highest committed migration when Story 2.6 is developed may differ from what is written here. Before generating the migration, run a fresh check of `packages/db/src/migrations/meta/_journal.json` and use the **next free sequential number** as the file prefix. Do NOT hardcode any specific migration number — re-read the journal every time. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.6 |
|---|---|
| 2.0 | Provides the `(app)` layout, `AppShell`, `+layout.server.ts` auth guard, and the `data.user` object (includes `orgId`, `orgRole`, `mfaStatus`). The wizard guard must hook into the **same layout hierarchy** — do not add a parallel auth mechanism. |
| 2.1 | `POST /api/v1/projects` is how users create the "first project" the wizard refers to. The wizard Step 1 landing must gracefully handle users who have already created a project (e.g., browser refresh mid-wizard). Do not duplicate project-creation logic. |
| 2.2 | `POST /api/v1/projects/:projectId/credentials` is the endpoint called by wizard Step 2. The credential form in the wizard must pass `{ name, value, description?, tags?, expiresAt? }` exactly as Story 2.2 defines — no custom shape. The wizard MUST NOT bypass the encrypt-on-write path; it uses the public API, not an internal shortcut. |
| 2.3 | Future story; tags field in Step 2 form is optional but should be present so the UX is consistent when 2.3 lands. |
| 2.5 | The "What's next?" step (Step 3) includes a direct link to bulk import (Story 2.5 route). If that route does not exist yet, render the link as a `<span aria-disabled="true">` placeholder — never a dead link that errors. |
| 2.7 | Step 3 also mentions global search as a future capability. Reference it in copy only, no active link needed. |
| 8.x | The `onboarding.completed` audit event written when the wizard is dismissed must use a `user_identity_token` reference (NOT the raw `userId`) in the `actorTokenId` field — same as every other audit event in the project (PJ6 invariant from Epic 1 architecture notes). |

---

## Architecture Conflict Resolution (Read Before Coding)

| Architecture / Epic wording | Canonical implementation | Rationale |
|---|---|---|
| Architecture lists `/api/v1/` as REST-only prefix | Onboarding endpoints live at `GET/POST /api/v1/users/me/onboarding` — not under `/projects/:id/` | Onboarding state is user+org scoped, not project-scoped. The `me` convention follows Auth patterns already established in Epic 1. |
| FR47 states wizard is web-UI-only | The API endpoints (`GET/POST /api/v1/users/me/onboarding`) DO exist but are used exclusively by the frontend; they are not advertised in the OpenAPI spec as a developer-facing integration surface. Operators bootstrapping via Docker ENV or direct API calls are exempt from the wizard gate — the API has no wizard guard. | The spec says the *wizard itself* is UI-only; the persistence API is required for the frontend to function. |
| Architecture shows `onboarding/` component folder containing `ProjectWizard` | The component is named **`OnboardingWizard.svelte`** (not `ProjectWizard`) — this matches the slot in the architecture file `onboarding/ # ProjectWizard (bypass-proof first-run)` which is the intent, not a required filename. Use `OnboardingWizard.svelte` to avoid confusion with the project-creation component. | Naming conflict prevention |
| AC-E2c: Wizard triggers "once per user per org on first project creation only" | The trigger is actually **first web UI login after registration** — not "on project creation". The wizard check happens at app layout load, not at project creation. The "first project creation" language in AC-E2c refers to the wizard's content (step 1 encourages creating a first project), not the trigger event. | Epics readiness note (2026-06-27) clarifies: "Onboarding triggers once per user per org … `POST /api/v1/users/me/onboarding { completed: true }` makes the wizard never re-trigger on subsequent logins or project creation." The trigger is login-based, not action-based. |

---

## Database Schema

### New Table: `user_onboarding`

Create `packages/db/src/schema/user-onboarding.ts`:

```typescript
import { pgTable, uuid, timestamp, primaryKey } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { organizations } from './organizations.js'

export const userOnboarding = pgTable(
  'user_onboarding',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.orgId] }),
  })
)
```

**Schema decisions:**
- Composite primary key `(userId, orgId)` — a row's presence means the wizard is done; absence means it is not. No `status` enum needed.
- `completedAt` defaults to `now()` on insert — records when the user dismissed the wizard.
- No `updatedAt` — this is an insert-once record; there is no valid update path.
- **No RLS policy required** — users can only read/write their own row (enforced at the application/SecureRoute layer via `auth.userId`); unlike projects/credentials, there is no org-level sharing of onboarding state.
- Export from `packages/db/src/schema/index.ts`.

### Migration

Generate via `pnpm --filter @project-vault/db generate` after adding the schema file. The migration file name uses the next sequential prefix (see Prerequisites — verify `meta/_journal.json`). The migration SQL will look like:

```sql
CREATE TABLE IF NOT EXISTS "user_onboarding" (
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "org_id"       uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "completed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_onboarding_pkey" PRIMARY KEY ("user_id", "org_id")
);
```

No RLS policy block needed in this migration. The table does not need a separate org-context-set trigger because the application always passes `auth.userId` as the filter.

---

## API Specification

### `GET /api/v1/users/me/onboarding`

Returns the current user's onboarding completion state for the active org.

**Request:** No body. Auth context provides `userId` and `orgId`.

**Response 200:**
```json
{ "completed": false }
// or
{ "completed": true, "completedAt": "2026-06-28T14:30:00.000Z" }
```

**Response when completed:**
```json
{ "completed": true, "completedAt": "<ISO-8601 string>" }
```

**Behavior:** Queries `user_onboarding` for a row matching `(userId, orgId)`. If found → `completed: true`. If not found → `completed: false`.

**Security:** `requireAuth: true`, `requireMfa: false` (wizard must be reachable before MFA grace period expires so new users can onboard). **No audit event** on GET — this is a status poll, not a protected resource access.

**Route classification:** `INFORMATIONAL` in `ROUTE_ACTION_CLASSIFICATIONS`.

---

### `POST /api/v1/users/me/onboarding`

Marks the wizard as permanently completed for this user in this org.

**Request body:**
```json
{ "completed": true }
```

**Response 200:**
```json
{ "completed": true, "completedAt": "<ISO-8601 string>" }
```

**Response 409 (already completed):**
```json
{ "error": "onboarding_already_completed", "message": "Onboarding has already been completed for this user in this org." }
```

**Behavior:**
1. Validate body: `{ completed: true }` (the boolean must be `true` — `false` is rejected with 422 since you cannot "un-complete" onboarding).
2. Check for existing row in `user_onboarding`; if present, return 409.
3. Insert row `(userId, orgId)` in the same transaction as the audit event.
4. Write `onboarding.completed` audit event (see Audit section below).
5. Return `{ completed: true, completedAt }`.

**Idempotency note:** A 409 is the correct response for duplicate POSTs. The frontend must handle 409 gracefully (treat as success — wizard is already dismissed).

**Security:** `requireAuth: true`, `requireMfa: false`.

**Route classification:** `WRITE` in `ROUTE_ACTION_CLASSIFICATIONS`.

---

### Route File Location

```
apps/api/src/modules/onboarding/
  routes.ts       ← register GET + POST handlers via secureRoute()
  schema.ts       ← Zod schemas for request/response validation
  routes.test.ts  ← integration tests
```

Register the module in `apps/api/src/app.ts` alongside `projects`, `auth`, `vault`, etc.

---

## Audit Event

When `POST /api/v1/users/me/onboarding` succeeds, write to `audit_log_entries`:

```typescript
{
  eventType: 'onboarding.completed',
  actorTokenId: '<user_identity_token id>',   // NOT raw userId — PJ6 invariant
  resourceType: 'user_onboarding',
  resourceId: auth.userId,                    // the user whose onboarding is completing
  orgId: auth.orgId,
  payload: {
    orgId: auth.orgId,
    completedAt: completedAt.toISOString(),
  },
  keyVersion: currentAuditKeyVersion,
  hmac: computeAuditHmac(row),
}
```

Use `firstActorTokenIdForUser(tx, auth.userId)` exactly as done in `projects/routes.ts`. The audit write must be in the **same transaction** as the `user_onboarding` insert — if the audit write fails, the entire operation rolls back (fail-closed invariant from the architecture).

---

## Frontend: Onboarding Guard

### Where to Add the Guard

The guard belongs in `apps/web/src/routes/(app)/+layout.server.ts`. This file already loads `data.user` for all authenticated app routes. Extend it to:

1. Call `GET /api/v1/users/me/onboarding` using the server-side `fetch` (same pattern as project list in `+page.server.ts` files).
2. Expose `onboardingCompleted: boolean` in the returned data object.

**Example extension of `+layout.server.ts`:**
```typescript
// Inside the existing load() function, after auth check:
const onboardingRes = await fetch('/api/v1/users/me/onboarding', {
  headers: { cookie: request.headers.get('cookie') ?? '' },
})
const onboardingData = onboardingRes.ok ? await onboardingRes.json() : { completed: true }
// Fail-open: if onboarding API is down, do not trap users in wizard

return {
  user: /* existing user object */,
  onboardingCompleted: onboardingData.completed as boolean,
}
```

**Fail-open rationale:** If the onboarding API returns an error (non-2xx), treat `onboardingCompleted = true` so users are not trapped in the wizard due to a transient backend issue. Log the failure as an operational warning.

### Rendering the Wizard

In `apps/web/src/routes/(app)/+layout.svelte`, import and conditionally render the wizard:

```svelte
<script lang="ts">
  import AppShell from '$lib/components/shell/AppShell.svelte'
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte'

  let { data, children } = $props()
  let onboardingDone = $state(data.onboardingCompleted)
</script>

<AppShell user={data.user}>
  {#if !onboardingDone}
    <OnboardingWizard
      user={data.user}
      on:completed={() => { onboardingDone = true }}
    />
  {:else}
    {@render children()}
  {/if}
</AppShell>
```

**Critical behavior:** When `onboardingDone` is `false`, the `{@render children()}` is NOT rendered. The user sees only the wizard — they cannot navigate to dashboard, credentials, settings, or any other route. This is the bypass-proof guarantee from FR9.

---

## Frontend: `OnboardingWizard` Component

### File Location

```
apps/web/src/lib/components/onboarding/
  OnboardingWizard.svelte     ← root component (manages step state)
  OnboardingStep1.svelte      ← "Why projects?" educational step
  OnboardingStep2.svelte      ← "Add your first credential" inline form
  OnboardingStep3.svelte      ← "What's next?" summary + links
```

### Step State Machine

```
step: 1 → 2 → 3 → [POST /onboarding] → onboardingDone = true
```

- Steps advance only forward; there is no "back" button (the wizard is linear).
- Step 2 only enables the "Next" button after a credential has been successfully created via `POST /api/v1/projects/:projectId/credentials`.
- Step 3's "Finish" button calls `POST /api/v1/users/me/onboarding { completed: true }` and fires the `completed` event.

### Step 1: "Why Projects?"

**Purpose:** Build the mental model. Show that Project Vault is organized around projects, not environments. This is educational — no form fields.

**Content:**
- Heading: "Welcome to Project Vault"
- Visual: A simple diagram (CSS/SVG — no external image dependency) showing:
  `Organization → Project → [Credentials, Services, Certificates]`
- Copy: "Everything in Project Vault lives inside a Project. A project is a container for all the secrets, services, and certificates that belong together — like 'payments-api' or 'mobile-backend'. There are no environments; instead, each environment can be its own project, or you can use tags to distinguish them within a project."
- **NEVER** use the word "environment" as a first-class structural concept. Do not show: `Organization → Environment → Project`. That is the forbidden model (UX-DR1).
- CTA button: "Got it — Let's add a credential" → advances to Step 2.
- No "Skip" button. No navigation links to other pages. No close (×) button.

**Pre-condition check:** The wizard needs a project ID for Step 2. Before rendering Step 1, the guard should have already loaded the user's first project via `GET /api/v1/projects` and passed `projectId` as a prop. If the user has no projects yet (edge case: they logged in but never created one), show an intermediate sub-step: "First, create a project" with an inline mini project-creation form using the `POST /api/v1/projects` endpoint. This is not a separate wizard step — it is a conditional render within Step 1.

**Edge case: user refreshes the page on Step 1.** Since step state is in-memory (`$state`), a refresh resets to Step 1. This is acceptable — the user has not created a credential yet.

### Step 2: "Add Your First Credential"

**Purpose:** The bypass guard. The wizard does not complete until this form successfully creates a credential with a real non-empty `value`.

**Fields (all inline, no page navigation):**

| Field | Required | Validation | Notes |
|---|---|---|---|
| Name | Yes | Non-empty string, ≤255 chars | "e.g. STRIPE_SECRET_KEY" |
| Value | Yes | Non-empty string | Password input (hidden by default, reveal toggle) |
| Description | No | ≤1000 chars | Free text |
| Tags | No | Comma-separated or tag chips | Optional — do not block on tags |

**Submit behavior:**
1. Client-side validation: name and value must be non-empty → show inline error if blank.
2. `POST /api/v1/projects/:projectId/credentials` with `{ name, value, description?, tags? }`.
3. On success (201): store `credentialId` in local state, show success message ("✓ Credential saved securely"), enable "Next" button.
4. On error (422 validation): display inline field errors from the API response.
5. On error (non-422): display a generic error banner; let user retry.

**Critical constraint:** The "Next" button is **disabled** until a 201 response has been received. An empty or placeholder value must not allow progression. The API enforces this (Story 2.2 validates non-empty value), but the UI also validates client-side for UX.

**No placeholder/demo values:** Do not pre-fill the value field with anything. Do not have a "Skip this step" option. This step is intentionally ungated for the "wrong" path.

**Inline reveal toggle:** The value field must have a show/hide toggle (eye icon) — entering a long secret without any way to verify it is typed correctly is a UX blocker.

### Step 3: "What's Next?"

**Purpose:** Reward and orient. The user has completed the minimum viable onboarding loop. Show them where to go next.

**Content:**
- Heading: "You're set up!"
- Subheading: "Here's what you can do next:"
- List of actions:
  1. **"Import credentials in bulk"** → link to `/credentials/import` (Story 2.5 route). If the route is not yet live, render as a disabled link with tooltip "Coming soon" — never a dead/404 link.
  2. **"Add more credentials manually"** → link to the credential creation page for the current project.
  3. **"Invite your team"** → link to the org settings page (placeholder if Epic 4 is not yet merged).
  4. **"Explore the dashboard"** → link to `/dashboard`.
- CTA button: "Go to Dashboard" — this button calls `POST /api/v1/users/me/onboarding { completed: true }` and on success fires `on:completed`. On 409 (already completed), treat as success.
- No back button.

**Global search mention:** Include a subtle copy line: "Global search across all your projects is coming soon." — text only, no link.

---

## Accessibility Requirements

- The wizard must be a modal-like overlay: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the step heading.
- Focus is trapped inside the wizard when it is visible. On step advance, focus moves to the new step's heading.
- The reveal toggle on the value field must have `aria-label="Show value"` / `aria-label="Hide value"` that updates on toggle.
- All form inputs must have associated `<label>` elements (not just placeholders).
- Color is not the sole indicator of validation state — include error text alongside any red border.
- Keyboard navigation: Tab cycles within the wizard only (no focus escaping to the behind content).
- Meets WCAG 2.1 AA — the project uses `axe-core` in CI (see architecture cross-cutting concern #10).

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | `user_onboarding` table with composite PK `(userId, orgId)` and `completedAt` timestamp. No RLS policy. Exported from schema index. Migration numbered correctly per journal. |
| GET endpoint | `GET /api/v1/users/me/onboarding` returns `{ completed: false }` for new users; `{ completed: true, completedAt }` for users who have completed. No audit event. Classified INFORMATIONAL. |
| POST endpoint | `POST /api/v1/users/me/onboarding { completed: true }` inserts row + writes `onboarding.completed` audit event atomically. Returns 409 if already completed. Body with `completed: false` returns 422. |
| Bypass-proof | When `onboardingCompleted = false`, the `(app)` layout renders ONLY the wizard — all other routes/children are blocked. No navigation, no skip, no close button. |
| Step 1 | Educational visual, project-centric model only, no environment layer, CTA advances to Step 2. If user has no project, shows inline project-creation sub-step. |
| Step 2 | Inline credential form: name + value required. Submit calls Story 2.2's `POST /…/credentials`. "Next" button disabled until 201 received. Empty/placeholder values blocked by both UI validation and API. |
| Step 3 | Links to import, manual credential add, team invite, dashboard. "Go to Dashboard" calls POST onboarding endpoint, handles 409 as success, fires `on:completed`. |
| Audit | `onboarding.completed` event: `actorTokenId` is `user_identity_token` reference (NOT raw userId). Written in same transaction as insert. Audit write failure → full rollback (fail-closed). |
| No re-trigger | After wizard is completed, subsequent logins and project creations do NOT re-trigger the wizard. `GET /onboarding` returns `{ completed: true }` on every subsequent load. |
| Operator exemption | Users who accessed the system via Docker ENV bootstrap or direct API (no web UI first access) are not blocked by the wizard when they first open the web UI — if they have already completed actions (e.g., have a project via API), the wizard still fires. The wizard is for web UI first-access; it does not check how the org was bootstrapped. |
| Route audit | Both routes registered in `ROUTE_FILES` + `ROUTE_ACTION_CLASSIFICATIONS`. `route-audit.test.ts` passes. |
| Accessibility | `role="dialog"`, `aria-modal`, focus trap, no axe-core violations in CI. |
| Tests | See Testing Requirements section. |

---

### AC-1: Database Schema — `user_onboarding` Table

**Given** the Drizzle schema conventions in `packages/db/src/schema/` (use `uuid`, `timestamp`, `primaryKey`),
**When** Story 2.6 adds the `user_onboarding` table,
**Then** the table has:
- `userId uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `orgId uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
- `completedAt timestamptz NOT NULL DEFAULT now()`
- Composite PK `(userId, orgId)`
- No RLS policy (application-layer enforcement only)
- Exported from `packages/db/src/schema/index.ts` as `userOnboarding`
- Migration applied with `pnpm --filter @project-vault/db migrate` without errors
- **`EXCLUDED_TABLES` guard (CI-critical):** `user_onboarding` carries an `org_id` column (via direct FK to `organizations`) but intentionally has NO RLS policy. The `check-rls-coverage.ts` script will therefore flag it as a coverage gap. Add `'user_onboarding'` to the `EXCLUDED_TABLES` set in `scripts/check-rls-coverage.ts` (mirroring existing exclusions) with a comment explaining the exemption: `// user_onboarding: no RLS — access gated in application layer by auth.userId == userId; org_id is a FK for cascade, not for multi-tenant row filtering.` Run `pnpm check-rls` after to confirm zero gaps reported.

**Example verification:**
```sql
-- After migration, this should return exactly one row for a completed user
SELECT * FROM user_onboarding WHERE user_id = '<userId>' AND org_id = '<orgId>';
-- Returns: { user_id, org_id, completed_at }

-- For a user who has not completed onboarding:
SELECT * FROM user_onboarding WHERE user_id = '<newUserId>' AND org_id = '<orgId>';
-- Returns: (0 rows)
```

---

### AC-2: GET Onboarding Status — New User

**Given** a freshly registered user `alice@example.com` who has just logged in for the first time,
**When** the app layout loads and calls `GET /api/v1/users/me/onboarding`,
**Then:**
- HTTP status 200
- Response body: `{ "completed": false }`
- No row exists in `user_onboarding` for `(alice.id, org.id)`
- No audit event is written
- Response time < 100ms (single point lookup on PK)

**Example test setup:**
```typescript
// Create user, create org, create org membership, obtain session token
// Call GET /api/v1/users/me/onboarding with session
// Assert: 200, { completed: false }
// Assert: db.select from user_onboarding where userId = alice.id → 0 rows
```

---

### AC-3: GET Onboarding Status — Completed User

**Given** a user `bob@example.com` who completed the wizard 2 days ago,
**When** `GET /api/v1/users/me/onboarding` is called,
**Then:**
- HTTP status 200
- Response body: `{ "completed": true, "completedAt": "2026-06-26T10:00:00.000Z" }`
- The `completedAt` matches the timestamp stored in `user_onboarding`

---

### AC-4: POST Marks Wizard Completed — Happy Path

**Given** user `alice` has NOT completed onboarding (`user_onboarding` has no row for alice+org),
**When** `POST /api/v1/users/me/onboarding` with body `{ "completed": true }`,
**Then:**
- HTTP status 200
- Response body: `{ "completed": true, "completedAt": "<ISO-8601>" }`
- `user_onboarding` now has exactly one row `(alice.id, org.id)` with a non-null `completedAt`
- `audit_log_entries` has one new row with `event_type = 'onboarding.completed'`, `resource_type = 'user_onboarding'`, `resource_id = alice.id`, `actor_token_id = <alice's user_identity_token id>` (NOT the raw UUID)
- The audit row's `hmac` passes `verifyAuditHmac()` check
- Subsequent `GET /api/v1/users/me/onboarding` returns `{ completed: true, ... }`

**Example test:**
```typescript
// POST with completed: true
// Assert: 200, body.completed === true, body.completedAt is valid ISO-8601
// Assert: user_onboarding has row
// Assert: audit_log_entries has onboarding.completed event with correct actorTokenId
// Assert: GET /onboarding now returns completed: true
```

---

### AC-5: POST with `completed: false` is Rejected

**Given** any authenticated user,
**When** `POST /api/v1/users/me/onboarding` with body `{ "completed": false }`,
**Then:**
- HTTP status 422
- Response body contains a validation error
- No row is inserted in `user_onboarding`
- No audit event is written

**Rationale:** Onboarding is a one-way gate. There is no valid "un-complete" action; accepting `false` would either be a no-op or create a confused state.

---

### AC-6: POST is Idempotent — 409 on Duplicate

**Given** user `bob` has already completed the wizard (row exists in `user_onboarding`),
**When** `POST /api/v1/users/me/onboarding` with body `{ "completed": true }` is called again,
**Then:**
- HTTP status 409
- Response body: `{ "error": "onboarding_already_completed", "message": "..." }`
- No new row is inserted
- No new audit event is written
- The original `completedAt` in `user_onboarding` is unchanged

**Frontend handling:** The wizard's Step 3 "Go to Dashboard" button must handle 409 as a success — the wizard closes normally. This covers the case where the user double-clicks the button or the request is retried after a network timeout.

---

### AC-7: Wizard is Bypass-Proof

**Given** user `carol` is authenticated and has NOT completed onboarding,
**When** carol navigates to any `(app)` route (e.g., `/dashboard`, `/credentials`, `/settings`),
**Then:**
- The wizard renders and occupies the full viewport
- The underlying page content (`{@render children()}`) is NOT rendered in the DOM
- No navigation links in `PrimaryNav` are clickable or focusable (they are not rendered)
- Direct URL entry (e.g., typing `/settings` in the address bar) does NOT bypass the wizard — the layout guard always re-checks `onboardingCompleted` from the server
- The browser DevTools cannot reveal sensitive UI behind the wizard (it is not rendered, not hidden with CSS)

**Verification:**
```typescript
// Playwright test: carol logs in, navigates to /dashboard
// Assert: wizard overlay is visible
// Assert: document.querySelector('[data-testid="primary-nav"]') is null (not rendered)
// Assert: document.querySelector('[data-testid="dashboard-content"]') is null (not rendered)
// Navigate to /settings → still sees wizard
// Assert: wizard is still visible
```

---

### AC-8: Step 2 — Credential Must Have Real Non-Empty Value

**Given** carol is on Step 2 of the wizard with the credential form visible,
**When** carol submits the form with an empty `value` field,
**Then:**
- The form does NOT submit to the API
- An inline error message appears below the `value` field: "Credential value cannot be empty"
- The "Next" button remains disabled

**When** carol submits with `name = ""` (empty name),
**Then:**
- An inline error appears below the `name` field: "Name is required"

**When** carol submits with `name = "MY_API_KEY"` and `value = "sk_live_abc123"`,
**Then:**
- `POST /api/v1/projects/:projectId/credentials` is called with `{ name: "MY_API_KEY", value: "sk_live_abc123" }`
- On 201 response: success message shows, "Next" button becomes enabled
- The `value` is NOT stored anywhere in the wizard component's state after receiving the 201 (clear it immediately after submission)

**Vault-sealed error handling (Step 2):**
When `POST /api/v1/projects/:projectId/credentials` returns 503, show a specific error:
> "The vault is sealed — credentials cannot be saved right now. Ask your administrator to unseal the vault."
Do NOT show a generic retry button for 503. The user cannot resolve a sealed vault themselves.

**Name field accidentally used for secret value:**
The `name` field must be `type="text"` with `autocomplete="off"`. Add a visible label distinction: "Name (public identifier)" vs "Value (stored securely)". This reduces the risk of users accidentally typing secrets into the name field.

**Value field input attributes:**
```html
<input
  type="password"
  name="credential-value"
  autocomplete="new-password"
  inputmode="text"
  aria-label="Credential value"
/>
```
`autocomplete="new-password"` prevents password managers from incorrectly auto-filling this with the user's login password.

**Checking the reveal toggle:**
**Given** the value field is in hidden mode (default),
**When** carol clicks the reveal toggle (eye icon),
**Then:** the input type changes from `password` to `text` and the icon changes to an eye-slash. The `aria-label` on the button updates: `"Show value"` → `"Hide value"`.

---

### AC-9: Step 3 — Finish Calls POST and Fires Completion Event

**Given** carol has successfully created a credential in Step 2 and is now on Step 3,
**When** carol clicks "Go to Dashboard",
**Then:**
- `POST /api/v1/users/me/onboarding { completed: true }` is called
- On 200: the `completed` event fires, `onboardingDone` becomes `true` in the layout, the wizard unmounts, and `{@render children()}` renders — carol now sees the dashboard
- On 409: same behavior as 200 — wizard closes normally
- On 5xx: an error banner shows in Step 3 ("Something went wrong — please try again"); the button re-enables so carol can retry

---

### AC-10: No Re-Trigger on Subsequent Logins or Project Creation

**Given** user `dave` has completed onboarding yesterday,
**When** dave logs in today (session expiry → re-authentication),
**Then:**
- `GET /api/v1/users/me/onboarding` returns `{ completed: true }`
- The `(app)` layout renders `{@render children()}` directly — no wizard

**When** dave creates a second project,
**Then:**
- The wizard does NOT appear during or after project creation
- `GET /api/v1/users/me/onboarding` still returns `{ completed: true }`

---

### AC-11: Audit Invariants

**Given** any `POST /api/v1/users/me/onboarding` request that succeeds,
**When** inspecting `audit_log_entries`,
**Then:**
- `actor_token_id` is a valid `user_identity_tokens.id` (not the raw `users.id`)
- `event_type = 'onboarding.completed'`
- `resource_type = 'user_onboarding'`
- `org_id` matches the authenticated user's org
- `hmac` is valid (passes `verifyAuditHmac()`)
- The row was committed in the same transaction as the `user_onboarding` insert

**Fail-closed test:**
```typescript
// Simulate audit write failure: mock computeAuditHmac() to throw
// POST /api/v1/users/me/onboarding
// Assert: 500 response
// Assert: user_onboarding table has NO row for this user (transaction rolled back)
```

---

### AC-12: Accessibility — Wizard is a Valid Dialog

**Given** carol is presented with the onboarding wizard,
**When** an axe-core accessibility scan runs,
**Then:**
- Zero violations at WCAG 2.1 AA level
- `role="dialog"` and `aria-modal="true"` are present on the wizard root element
- `aria-labelledby` points to the step heading `id`
- Tab key cycles WITHIN the wizard (focus trap active) — Tab from the last focusable element wraps to the first
- Pressing the first focusable element inside the wizard with Shift+Tab does NOT move focus outside the wizard
- On step advance, focus moves to the new step's heading (`h2`) element

---

### AC-13: Route Audit CI Gate

**Given** the `route-audit.test.ts` CI gate,
**When** Story 2.6's routes are registered,
**Then:**
- `GET /api/v1/users/me/onboarding` is in `ROUTE_FILES` and classified `INFORMATIONAL`
- `POST /api/v1/users/me/onboarding` is in `ROUTE_FILES` and classified `WRITE`
- `route-audit.test.ts` passes with zero unclassified routes
- **`AuditEventType` update (CI-critical):** add `'onboarding.completed'` to the `AuditEventType` union in `packages/shared/src/constants/audit-events.ts`. The event string must be byte-identical to the value used in `writeAuditEvent` and `ROUTE_ACTION_CLASSIFICATIONS`. Run `pnpm --filter @project-vault/shared test` and `pnpm typecheck` after to confirm no references to an undefined event name remain.

---

### AC-13b: Role-Aware Step 2 — Viewer Users Cannot Create Credentials

**Given** user `frank` was invited to an org as a `viewer` (read-only) and has no `member` or higher role,
**When** the wizard reaches Step 2 ("Add your first credential"),
**Then:**
- The standard credential creation form is NOT shown (frank cannot call `POST /…/credentials` — it will return 403)
- Instead, Step 2 shows: "Credential creation requires Member access. Ask your admin to upgrade your role, or explore the dashboard to see what your team has already secured."
- A "Continue to Dashboard" button calls `POST /api/v1/users/me/onboarding { completed: true }` and dismisses the wizard — viewers are not blocked forever
- This alternate path does NOT require credential creation; the wizard acknowledges the role limitation and completes gracefully

**Role check implementation:**
```typescript
// In OnboardingStep2.svelte, check user.orgRole before rendering the form
const canCreateCredential = ['member', 'admin', 'owner'].includes(user.orgRole)
```

**When** `frank` is later upgraded to `member` and logs in,
**Then:**
- The wizard is already completed (`user_onboarding` has a row) — the wizard does NOT re-trigger even though frank now has more permissions

---

### AC-13c: Mobile Responsiveness

**Given** user `grace` is accessing the wizard on a mobile browser (viewport width 375px),
**When** each step renders,
**Then:**
- Step 1 diagram is responsive — implemented as CSS flexbox or inline SVG with `viewBox` and `width="100%"`, never a fixed-pixel-width image
- Step 2 form fields are full-width on mobile (`width: 100%`)
- The `value` input uses `autocomplete="new-password"` to prevent password managers from auto-filling incorrectly
- The "Got it" / "Save Credential" / "Go to Dashboard" buttons have a minimum touch target of 44×44px
- No horizontal scroll at 375px viewport
- The wizard overlay has `max-height: 100dvh` and `overflow-y: auto` so Step 2 form is scrollable if the keyboard pushes content up

**Platform coverage:** This aligns with FR72 (mobile browser support) — the wizard is part of the web UI and must meet the same mobile bar as the rest of the product.

---

### AC-13d: Viewer + No Projects Edge Case

**Given** user `henry` was invited to an org as a `viewer` AND no projects exist in the org yet,
**When** the wizard initializes,
**Then:**
- The project pre-condition check (`GET /api/v1/projects`) returns an empty list
- The mini project-creation sub-step is NOT shown (henry is a `viewer` and cannot create a project)
- Instead: "Your admin hasn't created any projects yet. Check back when a project is set up for you, or ask your admin to invite you to an existing project."
- A "Got it" / "Dismiss" button calls `POST /api/v1/users/me/onboarding { completed: true }` — henry is not trapped indefinitely
- After dismissal, henry sees the dashboard (which shows the empty cross-project state from Story 2.1)

---

### AC-14: User With No Projects — Wizard Handles Gracefully

**Given** a new user `eve` who registered but has not yet created any project (edge case: they hit the web UI before creating a project via the wizard or API),
**When** the wizard initializes and calls `GET /api/v1/projects`,
**Then:**
- If the response returns an empty list, Step 1 renders the inline mini project-creation sub-step instead of jumping to the credential form
- The sub-step creates a project via `POST /api/v1/projects` with the user-entered name
- On success, the wizard stores the new `projectId` and advances to Step 1's main content
- The overall wizard flow then continues normally to Step 2 and Step 3

**Example:** eve sees:
> "First, let's create a project. What is it for?"
> [Project name input] [Create Project button]
> After creation → sees "Why projects?" educational content → "Got it" → Step 2

---

### AC-15: Operator API Bootstrapped User — Wizard Still Fires

**Given** an operator who bootstrapped their org and created projects using the REST API (not the web UI), and has NOT accessed the web UI before,
**When** they open the web UI for the first time,
**Then:**
- `GET /api/v1/users/me/onboarding` returns `{ completed: false }` (no wizard record exists)
- The wizard fires and shows the first step
- Since they already have projects, the project pre-condition is met and Step 1 shows the educational content directly (no mini project-creation sub-step)
- They must create at least one credential via Step 2 to dismiss the wizard

**Design rationale:** Operators who know their way around can still complete the wizard quickly (it creates one more credential). The wizard teaches the mental model, not just the mechanics. There is no "skip for advanced users" option.

---

## Testing Requirements

### Test File Structure

```
apps/api/src/modules/onboarding/routes.test.ts   ← API integration tests
apps/web/src/lib/components/onboarding/OnboardingWizard.test.ts  ← Svelte unit tests
apps/web/src/routes/onboarding.e2e.test.ts       ← Playwright E2E tests (if E2E suite exists)
```

### Required API Test Cases (`routes.test.ts`)

| Test | Description |
|---|---|
| GET — new user | `completed: false`, 0 rows in `user_onboarding` |
| GET — completed user | `completed: true`, `completedAt` returned |
| GET — unauthenticated | 401 |
| GET — cross-org isolation | User A's token cannot see user B's onboarding state |
| POST — happy path | 200, row inserted, audit event written with correct `actorTokenId` |
| POST — `completed: false` | 422, no row inserted |
| POST — missing body | 422 |
| POST — already completed (409) | 409, original row unchanged |
| POST — audit write failure (fail-closed) | 500, `user_onboarding` row NOT inserted |
| POST — unauthenticated | 401 |
| Route audit | Both routes in `ROUTE_ACTION_CLASSIFICATIONS`, `route-audit.test.ts` passes |

### Required Svelte Unit Test Cases (Svelte Testing Library)

| Test | Description |
|---|---|
| Step 1 renders | Educational content visible, no environment layer text |
| Step 1 CTA advances to Step 2 | Click "Got it" → Step 2 visible, Step 1 hidden |
| Step 2 — empty name blocked | Submit with empty name → inline error, no API call |
| Step 2 — empty value blocked | Submit with empty value → inline error, no API call |
| Step 2 — API success enables Next | Mock POST credentials 201 → Next button enabled |
| Step 2 — API 422 shows inline errors | Mock POST credentials 422 → field errors shown |
| Step 2 — reveal toggle works | Click eye icon → input type becomes "text", aria-label updates |
| Step 2 — vault sealed 503 shows specific message | Mock POST credentials 503 → "vault is sealed" error shown, no generic retry |
| Step 2 — viewer role shows alternate path | user.orgRole = 'viewer' → form NOT shown, "Contact admin" message shown |
| Step 3 — finish calls POST onboarding | Click "Go to Dashboard" → POST onboarding called |
| Step 3 — 409 treated as success | Mock POST onboarding 409 → `oncompleted` callback fired |
| Step 3 — 5xx shows error banner | Mock POST onboarding 500 → error banner visible, button re-enabled |
| Bypass proof | wizard rendered → PrimaryNav not in DOM |
| No environment layer in DOM | Assert no text matching `/^environment$/i` as structural concept in any step |
| Org-scoped re-trigger | wizard fires again for new orgId even after completion in previous orgId |
| Step state is in-memory | Page refresh on Step 2 (before credential created) → resets to Step 1 |

### Required Playwright E2E (if E2E suite configured)

| Test | Description |
|---|---|
| Full wizard completion | Register → login → wizard appears → complete all 3 steps → dashboard visible |
| Bypass proof | Navigate to `/settings` while wizard active → still see wizard |
| No re-trigger | Complete wizard → logout → login → wizard does NOT appear |
| Accessibility scan | axe-core on wizard with zero AA violations |

---

## File Structure Summary

```
packages/db/src/schema/
  user-onboarding.ts              ← NEW: schema definition
  index.ts                        ← MODIFIED: export userOnboarding

packages/db/src/migrations/
  XXXX_user_onboarding.sql        ← NEW: migration (number = next in journal)
  meta/_journal.json              ← MODIFIED: new entry
  meta/XXXX_snapshot.json         ← NEW: Drizzle snapshot

apps/api/src/modules/onboarding/
  routes.ts                       ← NEW: GET + POST handlers
  schema.ts                       ← NEW: Zod request/response schemas
  routes.test.ts                  ← NEW: integration tests

apps/api/src/app.ts               ← MODIFIED: register onboarding module

apps/web/src/routes/(app)/
  +layout.server.ts               ← MODIFIED: add onboarding status fetch
  +layout.svelte                  ← MODIFIED: conditional wizard rendering
                                    ⚠️ Story 2.7 also modifies this file (adds GlobalSearch + Cmd+K).
                                    Merge carefully: preserve the onboarding guard block when 2.7 is implemented.

apps/web/src/lib/components/onboarding/
  OnboardingWizard.svelte         ← NEW: root step manager
  OnboardingStep1.svelte          ← NEW: "Why projects?" step
  OnboardingStep2.svelte          ← NEW: credential creation form
  OnboardingStep3.svelte          ← NEW: "What's next?" + finish CTA
  OnboardingWizard.test.ts        ← NEW: Svelte unit tests
```

---

## Security Considerations

1. **No value exposure:** The wizard calls `POST /api/v1/projects/:projectId/credentials` which stores the encrypted value. The wizard component must NOT hold the plaintext value in any reactive state after the 201 response — clear it immediately.

2. **No bypass via CSS:** The behind-wizard content must not be rendered (not just hidden with CSS). `display: none` is insufficient — assistive technologies and devtools can still access the content. Use Svelte's `{#if}` blocks to conditionally render.

3. **Rate limiting:** `POST /api/v1/users/me/onboarding` is behind the standard user rate limit already enforced by `secureRoute()`. No special rate limit needed — a user can only complete onboarding once, so sustained abuse is self-limiting.

4. **Audit actor token:** Using `firstActorTokenIdForUser()` is mandatory — do NOT pass `auth.userId` directly to the audit row's `actor_token_id` field. Violation of PJ6 is a CI-caught security fault.

5. **Session scope:** The onboarding guard checks are server-side (in `+layout.server.ts`). A client-side `$state` of `onboardingDone` is an optimization for rendering — it must not be trusted as the authority. On every full page load, the server re-checks.

6. **The wizard is a UX gate, not a security gate:** A user who calls `POST /api/v1/users/me/onboarding { completed: true }` directly (via curl or DevTools) can dismiss the wizard without creating a credential. This is intentional. The wizard teaches the mental model; it does not protect any resource. The credential creation requirement (Step 2) is enforced by the UI only. Add `// NOTE: No credential-existence check — wizard is a UX gate, not a security gate.` comment in the route handler.

7. **CSS `display: none` is insufficient for bypass prevention.** The wizard overlay must use Svelte `{#if}` — not CSS hiding. Content hidden with CSS still exists in the DOM, is accessible to screen readers, and can be revealed by browser devtools. `{#if !onboardingDone}` / `{:else}` guarantees the behind-wizard DOM is not rendered.

---

## Developer Notes and Gotchas

1. **Organization table name:** Check the existing schema — the table might be `organizations` or `orgs`. Verify in `packages/db/src/schema/organizations.ts` before writing the FK reference.

2. **`firstActorTokenIdForUser` import path:** `import { firstActorTokenIdForUser } from '../audit/actor-token.js'` — same as in `projects/routes.ts`.

3. **Migration ordering:** The `user_onboarding` table references `users` and `organizations` — both created in Epic 1. This migration can run after any Epic 1 migration. No ordering constraint relative to other Epic 2 stories.

4. **SvelteKit `load` function in `+layout.server.ts`:** The existing `(app)/+layout.server.ts` likely already handles auth. Add the onboarding fetch AFTER the auth guard so it is only called for authenticated users. A 401 from the auth guard should redirect to login before the onboarding fetch runs.

5. **Fail-open vs. fail-closed:** The onboarding guard is fail-open (API error → assume completed). This is intentional — do not change it to fail-closed. Trapping a user in the wizard because the API is down is a worse outcome than showing the dashboard to a user who hasn't technically completed onboarding.

6. **The `oncompleted` callback (Svelte 5 runes):** The `+layout.svelte` already uses runes (`$props`, `$state`). Use a **callback prop** pattern — not `createEventDispatcher` (Svelte 3/4). Define the prop as `oncompleted: () => void` in the component's `$props()` destructure. The layout passes `oncompleted={() => { onboardingDone = true }}`.

7. **Do not touch the `(vault)` or `(auth)` layout routes.** The wizard is only in the `(app)` layout group. Vault unsealing and authentication remain outside the wizard scope.

8. **Project selection for Step 2:** If the user has multiple projects (unlikely at this stage but possible), default to the first project returned by `GET /api/v1/projects`. Do not show a project selector in the wizard — the mental model is single-project focus during onboarding.

9. **Wizard step state is in-memory (intentional architectural decision):** Steps are tracked via `$state` inside `OnboardingWizard.svelte`. There are NO URL changes during step navigation (no `goto()`, no `history.pushState()`). Rationale: (a) the wizard is ephemeral state — not a page flow; (b) avoids browser back-button inconsistency during wizard; (c) the URL remains `/dashboard` (or wherever the user was intercepted) throughout. A page refresh resets to Step 1 — this is acceptable since no data has been committed yet (the credential is committed only on Step 2 submit, and if the wizard resets, the user simply fills Step 2 again).

10. **SvelteKit client-side navigation and stale `onboardingCompleted` state:** SvelteKit re-runs `+layout.server.ts` `load()` on full page loads (initial load, F5) but NOT on pure client-side navigation between routes within the same layout group (e.g., navigating from `/dashboard` to `/settings` does not re-run the layout server load). This means: if a user completes the wizard in Tab A (fires `oncompleted`, `onboardingDone = true`), Tab B's in-memory `onboardingDone = false` remains until that tab does a full reload. This multi-tab inconsistency is **acceptable and expected** — the wizard is a soft UX gate, not a security boundary. Document this in code comments.

11. **The credential creation requirement (Step 2) is UI-enforced only — by design:** `POST /api/v1/users/me/onboarding` does NOT check whether any credential exists. A technically-savvy user who calls the API endpoint directly from DevTools before completing Step 2 can dismiss the wizard without creating a credential. This is intentional — the wizard is a UX confidence-builder, not a security gate. The product's value is in the data it holds; forcing credential creation server-side creates edge cases (role restrictions, project existence) that outweigh the benefit. Document this decision explicitly in the route handler with a code comment: `// NOTE: No credential-existence check — wizard is a UX gate, not a security gate.`

12. **Org-scoped per org, not per-user globally:** The `user_onboarding` PK is `(userId, orgId)`. This means: a user who completes onboarding in Org A will see the wizard again when they join or create Org B. This is intentional and correct — the wizard teaches org-level mental model (which org they are placing credentials in). If a user is confused by the re-trigger, it is an expected consequence of multi-org access and should be addressed in the copy of Step 1 ("Welcome to [OrgName]") rather than suppressing the wizard.

13. **Vault-sealed error in Step 2:** `POST /api/v1/projects/:projectId/credentials` returns 503 when the vault is sealed. The wizard must detect this specific error code and show: *"The vault is currently sealed. Ask your administrator to unseal it before adding credentials."* Do NOT show a generic retry banner — vault-sealed is not a transient recoverable error that retrying will fix.

14. **Copy tone — action-first, not patronizing:** The target user includes experienced DevOps engineers (Morgan persona) who may find educational wizard copy condescending. Every step's copy must be: brief (< 3 sentences per section), action-oriented, and acknowledgment-free ("you already know secret management tools" is the implicit framing). Avoid: "Let us show you how...", "Before you get started...", "First things first...". Prefer: direct capability statements. Each step should be completable in < 30 seconds for an experienced user.

---

## Definition of Done

- [ ] `user_onboarding` migration applied cleanly
- [ ] `GET /api/v1/users/me/onboarding` returns correct state for new and completed users
- [ ] `POST /api/v1/users/me/onboarding` inserts row + audit event atomically; 409 on duplicate; 422 on `completed: false`
- [ ] Both routes in `ROUTE_ACTION_CLASSIFICATIONS`; `route-audit.test.ts` passes
- [ ] `(app)/+layout.server.ts` fetches onboarding status
- [ ] `(app)/+layout.svelte` renders wizard when not completed; children when completed
- [ ] `OnboardingWizard.svelte` (+ Steps 1/2/3) renders correctly with no environment-layer text
- [ ] Step 2 blocks on empty name/value both client-side and API-side
- [ ] Step 2 clears plaintext value from component state after 201 response
- [ ] Step 3 "Go to Dashboard" calls POST; handles 200 + 409 as success; handles 5xx with retry
- [ ] Audit event uses `actorTokenId` from `user_identity_tokens` (not raw userId)
- [ ] Audit write failure → full transaction rollback (fail-closed)
- [ ] All API test cases pass (see Testing Requirements)
- [ ] All Svelte unit test cases pass
- [ ] axe-core: zero AA violations on wizard
- [ ] No text using "environment" as a structural concept (e.g., "environments layer") in wizard content
- [ ] Step 2 detects viewer role and shows alternate completion path (no credential creation required)
- [ ] Step 2 detects 503 vault-sealed and shows specific "vault is sealed" message (no generic retry)
- [ ] Wizard is responsive at 375px viewport (no horizontal scroll, min 44px touch targets)
- [ ] `value` field uses `autocomplete="new-password"`; `name` field uses `type="text"` with clear label distinction
- [ ] Developer note 11 code comment present: `// NOTE: No credential-existence check — wizard is a UX gate, not a security gate.`
- [ ] Developer note 9 code comment present explaining in-memory step state decision
- [ ] `pnpm check`, `pnpm lint`, `pnpm test` all pass in CI
