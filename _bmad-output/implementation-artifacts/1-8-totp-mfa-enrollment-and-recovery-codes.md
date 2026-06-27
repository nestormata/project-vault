# Story 1.8: TOTP MFA Enrollment & Recovery Codes

Status: review

<!-- Ultimate context engine analysis completed 2026-06-24 — comprehensive developer guide for TOTP enrollment, recovery codes, encrypted secret storage, replay protection, and MFA recovery login path. Covers FR54, FR55. Red Team hardening applied 2026-06-24. User Persona Focus Group applied 2026-06-24. Critique and Refine applied 2026-06-24 (AC quick ref, AC-1, AC-2, AC-4b, AC-6a/b/f, AC-8h, AC-9e, AC-16, AC-17 #22). -->

## Story

As a user who wants to secure my account with a second factor,
I want to enroll a TOTP authenticator app and generate one-time recovery codes,
so that my account remains protected even if my password is compromised, and I have a recovery path if I lose my authenticator device.

*Covers: FR54, FR55* [Source: _bmad-output/planning-artifacts/prd.md#Functional-Requirements]

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.6 complete — register, login, refresh, JWT cookies, Argon2id | Password verification for `/mfa/recover`; session issuance pattern reused |
| Story 1.7 complete — `authenticateRequest` plugin | All enrollment/regeneration routes require authenticated user |
| Story 1.5 complete — vault unsealed, `encrypt()` + `withSecret()` | TOTP secrets encrypted with vault primary key |
| Story 1.4 complete — `users`, `audit_log_entries`, `user_identity_tokens` | Schema + audit patterns |
| Story 1.2 complete — `BossService` lifecycle | pg-boss job for `totp_used_codes` cleanup |
| Real PostgreSQL in integration tests | No DB mocks for MFA flows |

### Epic Cross-Story Context

| Story | Relationship to 1.8 |
|---|---|
| 1.6 | Login/password verification; cookie issuance; `findPrimaryMembership()` for v1 single-org |
| 1.7 | Auth middleware on protected MFA routes; session + audit IP/UA capture |
| 1.9 | `failed_auth_attempts` recording for invalid TOTP — **defer** to 1.9; 1.8 returns errors only |
| 1.11 | SecureRoute factory will wrap these routes later — implement with same `preHandler: [authenticate]` pattern as 1.7 |
| 1.12 | Login MFA step (`mfaRequired`, `pending_mfa_sessions`) — **out of scope**; 1.8 only enrolls + recovery login. **Deploy warning:** do not ship 1.8 to production without 1.12 — password-only login remains valid for MFA-enrolled users until 1.12 gates login |
| 4.3 | Admin-governed account recovery (FR56) — different workflow; not this story |
| Epic 3 | Email alert on recovery code use — defer; write audit + `security_alerts` stub if needed |

---

## Architecture Conflict Resolution (Read Before Coding)

Epics.md uses simplified column names (`users.totp_secret_encrypted`, `users.mfa_enrolled`). **Architecture canonical names win** (same rule as Story 1.4 `org_memberships` vs `organization_members`):

| Epics wording | Canonical implementation | Rationale |
|---|---|---|
| `users.totp_secret_encrypted` | `mfa_enrollments.secret_encrypted` (JSONB `EncryptedValue`) | Architecture: separate `mfa_enrollments` table supports future multi-device MFA |
| `users.mfa_enrolled = true` | `users.mfa_enrolled_at = NOW()` (timestamptz, NULL = not enrolled) | Architecture canonical schema |
| `8x 16-character` recovery codes (architecture.md) | **10 codes**, `XXXXX-XXXXX` format (epics AC — FR55) | Epics is story AC source; update architecture doc in follow-up if needed |
| `422 { error: "invalid_totp" }` | `422 { code: "invalid_totp", message: "..." }` | Story 1.6+ error shape uses `code` not `error` |
| Audit `mfa.recovery_used` SSE-style name | `AuditEvent.MFA_RECOVERY_USED` constant | Architecture audit enum |

---

## Acceptance Criteria

### AC Quick Reference

| Route | Auth | Vault allowlist? | Rate limit | Key success | Key errors |
|---|---|---|---|---|---|
| `POST /mfa/enroll` | Yes | No | 10/h/user | `200` + QR/secret | `409 mfa_already_enrolled`, `401 access_token_missing` |
| `POST /mfa/verify-enrollment` | Yes | No | 20/15m/user | `200` + recovery codes | `422 invalid_totp`, `409 mfa_enrollment_not_started` |
| `POST /mfa/regenerate-recovery-codes` | Yes + TOTP | No | 5/h/user | `200` + new codes | `422 invalid_totp`, `409 mfa_not_enrolled` |
| `POST /mfa/recover` | No | **Yes** | 10/15m/IP + 5/15m/email | `200` + session cookies | `401 invalid_credentials`, `422 validation_error`, `429 rate_limit_exceeded` |

---

### AC-1: Module Structure & Route Registration

**Given** Stories 1.6–1.7 auth module exists,
**When** Story 1.8 is complete,
**Then** extend auth module:

```
apps/api/src/modules/auth/
├── routes.ts              # ADD MFA routes (see AC-2)
├── service.ts             # unchanged login/register; MFA orchestration delegates to mfa.ts
├── mfa.ts                 # NEW: enrollMfa(), verifyEnrollment(), recoverWithCode(), regenerateRecoveryCodes()
├── totp.ts                # NEW: generateSecret(), buildOtpAuthUrl(), validateTotp(), encrypt/decrypt secret helpers
├── recovery-codes.ts      # NEW: generateRecoveryCodes(), hashRecoveryCode(), verifyRecoveryCode(),
│                          #     countUnusedRecoveryCodes(), deletePendingEnrollmentForUser()
├── schema.ts              # ADD Zod schemas for MFA request/response bodies
└── tokens.ts              # unchanged

apps/api/src/workers/
├── prune-totp-used-codes.ts   # NEW: pg-boss handler — hourly (AC-11)
└── prune-mfa-pending.ts       # NEW: pg-boss handler — daily 24h TTL (AC-10 Option A)

packages/db/src/schema/
├── mfa-enrollments.ts         # NEW
├── mfa-recovery-codes.ts      # NEW
├── totp-used-codes.ts         # NEW
└── users.ts                   # ADD mfa_enrolled_at column

packages/shared/src/constants/
└── audit-events.ts            # ADD MFA_ENROLLMENT_STARTED, MFA_ENROLLED, MFA_RECOVERY_USED, MFA_RECOVERY_CODES_REGENERATED
```

**And** register routes under existing `/api/v1/auth` prefix from `app.ts` (no new mount).

**And** update `route-audit.test.ts`:

| Route | Auth required? |
|---|---|
| `POST /api/v1/auth/mfa/enroll` | Yes |
| `POST /api/v1/auth/mfa/verify-enrollment` | Yes |
| `POST /api/v1/auth/mfa/regenerate-recovery-codes` | Yes |
| `POST /api/v1/auth/mfa/recover` | **No** (public — vault guard allowlist) |

**And** all MFA routes are **POST-only** (same rule as AC-34 in Story 1.6).

---

### AC-2: API Endpoints Summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/mfa/enroll` | Yes | Start enrollment — return QR + secret |
| POST | `/api/v1/auth/mfa/verify-enrollment` | Yes | Confirm TOTP + receive recovery codes (once) |
| POST | `/api/v1/auth/mfa/regenerate-recovery-codes` | Yes + TOTP | Replace all recovery codes |
| POST | `/api/v1/auth/mfa/recover` | No | Login using password + recovery code (TOTP bypass) |

**Vault guard allowlist** — extend `apps/api/src/plugins/vault-guard.ts`:

| Route | On allowlist? | Rationale |
|---|---|---|
| `POST /api/v1/auth/mfa/enroll` | **No** | Requires primary key encryption — 503 when vault sealed |
| `POST /api/v1/auth/mfa/verify-enrollment` | **No** | Requires decrypt — 503 when sealed |
| `POST /api/v1/auth/mfa/regenerate-recovery-codes` | **No** | Requires decrypt — 503 when sealed |
| `POST /api/v1/auth/mfa/recover` | **Yes** | Public login path — same class as `/login` |

```typescript
// Add to VAULT_GUARD_ALLOWLIST (method + path key — match vault-guard.ts convention):
'POST /api/v1/auth/mfa/recover',
```

**Rate limits (extend Story 1.6 patterns — separate buckets from `/login`; login remains 60/min/IP per Story 1.6 AC-9):**

| Route | Limit | Key |
|---|---|---|
| `/mfa/enroll` | 10 / hour | `authContext.userId` |
| `/mfa/verify-enrollment` | 20 / 15 min | `authContext.userId` |
| `/mfa/regenerate-recovery-codes` | 5 / hour | `authContext.userId` |
| `/mfa/recover` | 10 / 15 min | client IP |
| `/mfa/recover` | **5 / 15 min** | normalized email (second limit — **both** must pass) |

**Recover dual-limit rationale:** User has at most 10 recovery codes; a single IP window could otherwise exhaust all codes when password is compromised. Per-email cap slows distributed guessing.

---

### AC-3: Environment Variables

**Add to `apps/api/src/config/env.ts`:**

| Variable | Type | Default | Validation |
|---|---|---|---|
| `MFA_TOTP_ISSUER` | string | `Project Vault` | 1–64 chars; used in `otpauth://` URI |
| `MFA_TOTP_PERIOD_SECONDS` | number | `30` | Must be `30` in v1 (RFC 6238 default) |
| `MFA_TOTP_DIGITS` | number | `6` | Must be `6` in v1 |
| `MFA_TOTP_WINDOW` | number | `1` | Accept current ± N windows (1 = ±30s skew) |
| `MFA_RECOVERY_CODE_COUNT` | number | `10` | Min 8, max 16 |
| `MFA_RECOVERY_CODE_BCRYPT_COST` | number | `12` | Min 10, max 14 |
| `TOTP_USED_CODES_TTL_MINUTES` | number | `90` | Rows older than this pruned by worker |
| `TOTP_REPLAY_HMAC_SECRET` | string | — | Min 32 bytes (base64 or hex); **required** when `NODE_ENV=production` |

**And** update `.env.example` + `scripts/check-env-example.ts`.

**Production guards:**

- Reject `MFA_RECOVERY_CODE_BCRYPT_COST < 10`
- Reject missing or weak `TOTP_REPLAY_HMAC_SECRET` (must differ from `REFRESH_TOKEN_HMAC_SECRET` in production)

**Development fallback:** If `TOTP_REPLAY_HMAC_SECRET` unset in non-production, log startup **warning** and fall back to `REFRESH_TOKEN_HMAC_SECRET` — never use this fallback in production.

---

### AC-4: Database Migration — MFA Tables

**Given** Story 1.6/1.7 migrations applied,
**When** `pnpm --filter @project-vault/db db:migrate` runs,
**Then** migration `0005_mfa_foundation.sql` (name may vary) applies:

#### AC-4a: Extend `users`

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_mfa_enrolled_at
  ON users (mfa_enrolled_at)
  WHERE mfa_enrolled_at IS NOT NULL;
```

**Semantics:** `mfa_enrolled_at IS NOT NULL` ⇔ user has completed MFA enrollment. No boolean column.

#### AC-4b: `mfa_enrollments`

```sql
CREATE TABLE mfa_enrollments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted  JSONB NOT NULL,          -- EncryptedValue from packages/crypto
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed')),
  label             TEXT NOT NULL DEFAULT 'Authenticator',
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_mfa_enrollments_user_pending
  ON mfa_enrollments (user_id)
  WHERE status = 'pending';

CREATE INDEX idx_mfa_enrollments_user_id ON mfa_enrollments (user_id);
```

**RLS:** No `org_id` — identity-scoped (like `refresh_tokens`). Access **only** from `modules/auth/mfa.ts` via platform transaction. Add `'mfa_enrollments'` to `EXCLUDED_TABLES` in `check-rls-coverage.ts`.

**v1 constraint:** One confirmed enrollment per user — enforced in service layer **and** DB:

```sql
CREATE UNIQUE INDEX idx_mfa_enrollments_user_confirmed
  ON mfa_enrollments (user_id)
  WHERE status = 'confirmed';
```

**Required** — do not omit this index.

#### AC-4c: `mfa_recovery_codes`

```sql
CREATE TABLE mfa_recovery_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,               -- bcrypt hash of normalized code
  used_at      TIMESTAMPTZ,                 -- NULL = unused; set on consumption (row retained for audit count)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mfa_recovery_codes_user_unused
  ON mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;

CREATE INDEX idx_mfa_recovery_codes_user_id ON mfa_recovery_codes (user_id);
```

**RLS:** No `org_id` — add `'mfa_recovery_codes'` to `EXCLUDED_TABLES`.

**Never store plaintext recovery codes** — only bcrypt hashes.

#### AC-4d: `totp_used_codes` (replay protection)

```sql
CREATE TABLE totp_used_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,               -- HMAC-SHA256 of (userId + timeCounter + totpDigits) — NOT the raw TOTP
  window_start TIMESTAMPTZ NOT NULL,        -- start of 30s window when code was accepted
  expires_at   TIMESTAMPTZ NOT NULL,        -- window_start + 90s (covers skew window)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_totp_used_codes_replay
  ON totp_used_codes (user_id, code_hash);

CREATE INDEX idx_totp_used_codes_expires_at ON totp_used_codes (expires_at);
```

**RLS:** No `org_id` — add `'totp_used_codes'` to `EXCLUDED_TABLES`.

**Why hash the TOTP?** Store `HMAC-SHA256(TOTP_REPLAY_HMAC_SECRET, userId:counter:digits)` — never store the 6-digit code itself. **Canonical:** dedicated `TOTP_REPLAY_HMAC_SECRET` (AC-3). Do not reuse refresh-token HMAC in production — compromise isolation.

#### AC-4e: Drizzle schema files

Create matching Drizzle definitions in `packages/db/src/schema/` and re-export from `index.ts`.

---

### AC-5: TOTP Secret Generation — `POST /api/v1/auth/mfa/enroll`

**Given** authenticated user (`request.authContext` from Story 1.7),
**When** `POST /api/v1/auth/mfa/enroll` with empty body `{}`,
**Then** `200`:

```json
{
  "data": {
    "enrollmentId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "otpauthUrl": "otpauth://totp/Project%20Vault:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Project%20Vault&algorithm=SHA1&digits=6&period=30",
    "secret": "JBSWY3DPEHPK3PXP",
    "qrCodeSvg": "<svg xmlns=\"http://www.w3.org/2000/svg\" ...></svg>"
  }
}
```

#### AC-5a: Secret generation rules

1. Generate **160-bit** (20-byte) random secret via `otpauth`:
   ```typescript
   import * as OTPAuth from 'otpauth'
   const secret = new OTPAuth.Secret({ size: 20 })
   ```
2. Base32-encode for display (`secret.base32`).
3. Encrypt secret bytes with vault primary key:
   ```typescript
   import { encrypt } from '@project-vault/crypto'
   const encrypted = await encrypt(Buffer.from(secret.buffer), getPrimaryKey())
   ```
4. Store in `mfa_enrollments` with `status = 'pending'`.

#### AC-5b: Pending enrollment replacement

If user already has a `pending` enrollment, **delete** the old pending row and create a new one (do not stack multiple pending secrets).

If user already has `mfa_enrolled_at IS NOT NULL`, return **`409 { code: "mfa_already_enrolled", message: "MFA is already enabled. Disable MFA is not supported in v1." }`**.

#### AC-5c: QR code generation

- Generate server-side SVG — **no external HTTP calls** (no Google Charts API).
- Add dependency: `qrcode` npm package (or `qr-code-styling` — prefer `qrcode` for minimal SVG output).
- QR encodes the **full `otpauthUrl`** string.
- SVG must be safe to embed — no `<script>` tags; escape user email in URI.

**Example implementation sketch:**

```typescript
import QRCode from 'qrcode'

export async function buildQrCodeSvg(otpauthUrl: string): Promise<string> {
  return QRCode.toString(otpauthUrl, { type: 'svg', margin: 2, width: 256 })
}
```

#### AC-5d: otpauth URL construction

```typescript
const totp = new OTPAuth.TOTP({
  issuer: env.MFA_TOTP_ISSUER,
  label: user.email,                    // user's email — NOT display name
  algorithm: 'SHA1',                    // Google Authenticator compatible
  digits: env.MFA_TOTP_DIGITS,
  period: env.MFA_TOTP_PERIOD_SECONDS,
  secret: OTPAuth.Secret.fromBase32(base32Secret),
})
const otpauthUrl = totp.toString()
```

#### AC-5e: Security — response exposure

- `secret` (base32) is returned **once** for manual entry — acceptable for enrollment UX.
- **Never log** `secret`, `otpauthUrl`, or TOTP codes — add to Pino redact paths: `req.body.totp`, `req.body.recoveryCode`.
- Enrollment routes require authentication — attacker cannot enumerate secrets without stolen session.

#### AC-5f: Unauthenticated request

`POST /mfa/enroll` without access cookie → **`401 { code: "access_token_missing" }`** (Story 1.7).

#### AC-5g: Session-hijack threat model (v1 accepted risk)

Enrollment requires **session auth only** — no password step-up in v1 (defer step-up re-auth to Story 1.9/1.11).

**Threat:** Attacker with stolen session can start enrollment and bind their authenticator before the victim enrolls, or grief by repeatedly failing verify (AC-6c).

**Mitigations in 1.8:**

1. Write `AuditEvent.MFA_ENROLLMENT_STARTED` when `/mfa/enroll` creates a pending row (same fields as AC-6g — no secret in payload)
2. Rate limits on enroll/verify (AC-2)
3. Pending row deleted on session revoke (AC-10 Option B)

**Audit on enroll start:**

```typescript
await writeAuditEntry(tx, {
  orgId: authContext.orgId,
  actorTokenId: userIdentityTokenId,
  actorType: 'human',
  eventType: AuditEvent.MFA_ENROLLMENT_STARTED,
  resourceId: enrollmentId,
  resourceType: 'mfa_enrollment',
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
  payload: { method: 'totp' },
})
```

**Do not** log `otpauthUrl`, `secret`, or QR SVG content.

---

### AC-6: Verify Enrollment — `POST /api/v1/auth/mfa/verify-enrollment`

**Given** user has pending `mfa_enrollments` row,
**When** `POST /api/v1/auth/mfa/verify-enrollment` with:

```json
{ "totp": "123456" }
```

**Then** on valid code:

1. Transition enrollment `status` → `'confirmed'`, set `confirmed_at = NOW()`
2. Set `users.mfa_enrolled_at = NOW()`
3. Generate `MFA_RECOVERY_CODE_COUNT` recovery codes (default 10)
4. Store bcrypt hashes in `mfa_recovery_codes`
5. Write `AuditEvent.MFA_ENROLLED` in same transaction (org-scoped via `withOrg`)
6. Return **`200`**:

```json
{
  "data": {
    "mfaEnrolledAt": "2026-06-24T12:00:00.000Z",
    "recoveryCodes": [
      "K7F2M-9QPLX",
      "R4N8W-3HJTC",
      "..."
    ]
  }
}
```

**Recovery codes shown exactly once** — no endpoint to retrieve them again.

#### AC-6a: TOTP validation rules

Use `otpauth` with window skew:

```typescript
const delta = totp.validate({ token: normalizedTotp, window: env.MFA_TOTP_WINDOW })
if (delta === null) return invalidTotp()
```

- Accept codes from the **current period and ±1 adjacent period** (`window: 1` = ±30s skew with 30s period).
- Normalize input: strip spaces; must match `/^\d{6}$/`.
- Invalid format → `422 { code: "validation_error", message: "...", details: [...] }` (Zod).

#### AC-6b: Replay protection on verify-enrollment

**After successful TOTP validation** (counter known from `validateTotpCode()` — do **not** insert replay rows for failed attempts):

1. Compute replay key: `codeHash = HMAC-SHA256(TOTP_REPLAY_HMAC_SECRET, \`${userId}:${counter}:${totp}\`)`
2. Insert into `totp_used_codes` via `recordTotpUse(userId, counter, totp, tx)`
3. Unique violation → `422 { code: "invalid_totp" }` (treat replay same as wrong code — no oracle)

Order within transaction (AC-6h): validate → record replay → confirm enrollment.

#### AC-6c: Invalid TOTP

Wrong code → **`422 { code: "invalid_totp", message: "The authenticator code is incorrect." }`**

**And** pending secret is **discarded** (delete pending `mfa_enrollments` row).

User must call `/mfa/enroll` again to restart.

#### AC-6d: No pending enrollment

No pending row → **`409 { code: "mfa_enrollment_not_started", message: "..." }`**

#### AC-6e: Recovery code generation

Each code:

- 10 random alphanumeric chars from charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (exclude ambiguous `0/O`, `1/I/L`)
- Format as `XXXXX-XXXXX` (5+5 with hyphen)
- Store `bcrypt.hash(normalize(code), MFA_RECOVERY_CODE_BCRYPT_COST)` where normalize = uppercase, strip hyphen

**Example generator:**

```typescript
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    let raw = ''
    for (let j = 0; j < 10; j++) {
      raw += CHARSET[crypto.randomInt(CHARSET.length)]
    }
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}
```

#### AC-6f: UI contract (API-only in this story)

See **AC-6i** for full persona-driven UI contract. API does not gate checkbox confirmation — Epic UI must enforce.

#### AC-6g: Audit event

```typescript
await writeAuditEntry(tx, {
  orgId: authContext.orgId,
  actorTokenId: userIdentityTokenId,
  actorType: 'human',
  eventType: AuditEvent.MFA_ENROLLED,
  resourceId: enrollmentId,
  resourceType: 'mfa_enrollment',
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
  payload: { method: 'totp' },   // NEVER include secret or codes
})
```

#### AC-6h: Transactional verify (concurrency + replay)

`verifyEnrollment()` **must** run in a **single DB transaction**:

1. `SELECT ... FROM mfa_enrollments WHERE user_id = ? AND status = 'pending' FOR UPDATE`
2. Decrypt secret via `withSecret()` — validate TOTP via `validateTotpCode()`; `counter` from return value only (never client-supplied). If invalid → delete pending row (AC-6c) and abort
3. `recordTotpUse(userId, counter, totp, tx)` — unique violation → `422 invalid_totp` (AC-6b)
4. Confirm enrollment, set `mfa_enrolled_at`, insert recovery code hashes, audit `MFA_ENROLLED`
5. Commit

**Concurrent duplicate verify:** Two parallel requests with the same valid TOTP — exactly one succeeds; the other gets `422 invalid_totp` (replay insert or row lock ordering).

**Invalid TOTP path:** Still delete pending row (AC-6c) within the same transaction before commit.

#### AC-6i: Persona-driven UI contracts (Epic UI — mandatory UX, API documents only)

Per UX-DR3 contextual education at the decision point. API does **not** gate these — frontend **must** implement:

| Moment | UI requirement | Persona driver |
|---|---|---|
| Before verify TOTP | Inline warning: *"One incorrect code cancels setup — you'll need to scan the QR again."* | Jordan (first-time MFA) |
| Recovery codes screen | Full-screen step; codes + copy/download; **"I have saved these codes"** checkbox required before continue; no backdrop dismiss | Jordan, UX-DR3 |
| Recover login | Accept codes with or without hyphen; case-insensitive; show format hint `XXXXX-XXXXX` | Morgan (2am mobile) |
| After recover success | Banner using `remainingRecoveryCodes`: *"You have N recovery codes remaining — regenerate in Settings when you can."* | Morgan, Sam |
| Regenerate confirm | Destructive modal: *"This invalidates all existing recovery codes immediately."* | Alex (Owner) |
| `remainingRecoveryCodesCount ≤ 2` | Persistent warning on Security settings | Sam (monitoring) |
| Zero codes + lost device | Copy: *"Contact your organization administrator"* → Epic 4.3 admin recovery | CTO (buyer) |

---

### AC-7: TOTP Validation Helper — Shared Module

**Create `apps/api/src/modules/auth/totp.ts`** exporting:

```typescript
export type DecryptedTotpSecret = { base32: string; enrollmentId: string }

export async function decryptEnrollmentSecret(
  encrypted: EncryptedValue,
): Promise<Buffer>  // internal only — immediately consumed by validateTotp

export function validateTotpCode(
  secretBase32: string,
  token: string,
  options?: { window?: number },
): { valid: boolean; counter?: number }

export async function recordTotpUse(
  userId: string,
  counter: number,  // MUST come from validateTotpCode() return — never from request body
  token: string,
  tx: Tx,
): Promise<void>  // throws on replay
```

**`recordTotpUse` contract:** `counter` is the RFC 6238 time counter derived from `validateTotpCode()`'s `delta` — callers must not pass client-controlled values. `expires_at = window_start + TOTP_USED_CODES_TTL_MINUTES`.

**Decrypt pattern (mandatory):**

```typescript
import { withSecret, bootstrapDecrypt } from '@project-vault/crypto'
// Use withSecret + getPrimaryKey() — NOT bootstrapDecrypt (vault is unsealed)
const plaintext = await withSecret(encrypted, async (buf) => buf)
```

**All TOTP validation for this story** goes through `validateTotpCode()` — Story 1.12 reuses it for login verification.

---

### AC-8: Recovery Login — `POST /api/v1/auth/mfa/recover`

**Given** user has MFA enrolled and lost authenticator device,
**When** `POST /api/v1/auth/mfa/recover` with:

```json
{
  "email": "user@example.com",
  "password": "twelve-characters-min",
  "recoveryCode": "K7F2M-9QPLX"
}
```

**Then** on success, issue full session (same as Story 1.6 login success):

```json
{
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "orgId": "660e8400-e29b-41d4-a716-446655440001",
    "expiresAt": "2026-06-24T12:05:00.000Z",
    "remainingRecoveryCodes": 7
  }
}
```

`remainingRecoveryCodes` = count of unused codes (`used_at IS NULL`) **after** consumption. Never include which code was used.

**And** set `access-token` + `refresh-token` HttpOnly cookies (reuse Story 1.6 `setAuthCookies()`).

#### AC-8a: Verification sequence (constant-time where possible)

1. Normalize email (NFKC + lowercase — same as Story 1.6 AC-32)
2. Lookup user by email — if not found, run dummy Argon2 + dummy bcrypt compare (timing oracle protection)
3. Verify password with Argon2id
4. Require `users.mfa_enrolled_at IS NOT NULL` — else treat as auth failure (AC-8b)
5. Normalize recovery code: uppercase, strip spaces/hyphens
6. Iterate unused recovery code hashes for user — use `bcrypt.compare` (inherent constant-time per compare)
7. On match: `SELECT ... FROM mfa_recovery_codes WHERE id = ? AND used_at IS NULL FOR UPDATE` — if still unused, set `used_at = NOW()` (do not delete row — audit trail)
8. Create session + refresh token (reuse `loginUser` session path from 1.6)
9. Write audit `MFA_RECOVERY_USED` in **same transaction** as code consumption + session create

**Steps 7–9 must be one transaction.** Concurrent requests with the same valid code: first commits; second sees `used_at` set → `401 invalid_credentials`.

#### AC-8b: Invalid credentials — unified response

Wrong password, wrong code, or no MFA enrolled → **`401 { code: "invalid_credentials", message: "Invalid email, password, or recovery code." }`**

**Never** distinguish which field failed (no enumeration oracle).

#### AC-8c: Recovery code reuse

Second use of same code → `401 invalid_credentials`.

#### AC-8d: Recovery code format validation

Malformed code (wrong length after normalize) → `422 validation_error` **before** password verify (cheap reject).

**Input flexibility (UI + API):** Normalize before verify — uppercase; strip spaces and hyphens. All of the following must work:

| User input | Normalized |
|---|---|
| `K7F2M-9QPLX` | `K7F2M9QPLX` |
| `k7f2m9qplx` | `K7F2M9QPLX` |
| `K7F2M 9QPLX` | `K7F2M9QPLX` |

After normalize, length must be exactly **10** alphanumeric chars (charset AC-6e). Zod accepts `min(10).max(16)` pre-normalize to allow optional hyphen/spaces.

#### AC-8e: Audit event

```typescript
eventType: AuditEvent.MFA_RECOVERY_USED
payload: {
  remainingRecoveryCodes: number,  // count where used_at IS NULL
  // NEVER include the recovery code
}
```

#### AC-8f: Epic 3 email deferral

Log at `info`:

```typescript
logger.info({ eventType: 'alert.pending_epic3', alertType: 'mfa.recovery_used', userId })
```

Optional: insert `security_alerts` row with `status = 'PENDING_DELIVERY'` if org context available.

#### AC-8g: User without unused recovery codes

All codes consumed → `401 invalid_credentials` (same unified message).

#### AC-8h: Per-email rate limit

Apply **5 requests / 15 min / normalized email** on `/mfa/recover` in addition to the per-IP limit (AC-2). Both limits must pass; exceeding either → `429 rate_limit_exceeded`.

Use `@fastify/rate-limit` with a custom `keyGenerator` on the recover route (email from body after Zod parse — do not rate-limit on malformed bodies beyond IP).

**Dual-limit implementation:** Register **two** `@fastify/rate-limit` instances scoped to the recover route (both as `preHandler` — first exceeded wins `429`):

```typescript
// 1. IP bucket — keyGenerator: (req) => req.ip
// 2. Email bucket — keyGenerator: (req) => normalizeEmail(parsedBody.email)
```

Apply IP limit even when body fails Zod (IP-only on malformed requests).

#### AC-8i: Concurrent recovery code redemption

Integration test (AC-17 #17): two parallel `POST /mfa/recover` with identical valid credentials — exactly one `200` with cookies; the other `401 invalid_credentials`. No double session from one code.

#### AC-8j: Failed recover audit

On any `401 invalid_credentials` from recover (wrong password, wrong code, not enrolled, no unused codes):

```typescript
await writeAuditEntry(tx, {
  orgId: primaryOrgId ?? null,  // if user found; skip org if unknown user
  actorType: 'human',
  eventType: AuditEvent.LOGIN_FAILED,  // reuse Story 1.6 constant
  payload: { method: 'recovery_code' },  // NEVER include email or code
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
})
```

If audit insert fails, still return `401` to client (same rule as Story 1.6 login).

#### AC-8k: Rate-limit UX contract

On `429 rate_limit_exceeded` for recover (IP or email bucket):

- Set **`Retry-After`** header (seconds until window resets)
- Response body:

```json
{
  "code": "rate_limit_exceeded",
  "message": "Too many attempts. Try again later.",
  "retryAfterSeconds": 900
}
```

**UI guidance (Epic UI — not enforced by API):** Show countdown from `retryAfterSeconds`; suggest verifying code format (`XXXXX-XXXXX`) before retry; after lockout, link to org-admin contact (Epic 4.3) if user may be out of codes.

---

### AC-9: Regenerate Recovery Codes — `POST /api/v1/auth/mfa/regenerate-recovery-codes`

**Given** authenticated user with MFA enrolled,
**When** `POST /api/v1/auth/mfa/regenerate-recovery-codes` with:

```json
{ "totp": "654321" }
```

**Then** on valid TOTP:

1. Validate TOTP against confirmed enrollment (with replay protection)
2. Mark **all** existing unused codes as used (`used_at = NOW()`) OR delete unused rows — prefer `used_at` for audit
3. Insert new batch of hashed codes
4. Audit `MFA_RECOVERY_CODES_REGENERATED`
5. Return **`200`**:

```json
{
  "data": {
    "recoveryCodes": ["...", "..."],
    "generatedAt": "2026-06-24T12:30:00.000Z"
  }
}
```

#### AC-9a: Invalid TOTP

→ `422 { code: "invalid_totp" }` — **do not** invalidate existing codes on failed attempt.

#### AC-9b: Not enrolled

→ `409 { code: "mfa_not_enrolled" }`

#### AC-9c: Rate limit exceeded

→ `429 { code: "rate_limit_exceeded" }`

#### AC-9d: Epic 3 alert on regenerate

On successful regenerate, log (mirror AC-8f):

```typescript
logger.info({ eventType: 'alert.pending_epic3', alertType: 'mfa.recovery_codes_regenerated', userId })
```

Optional: insert `security_alerts` row with `status = 'PENDING_DELIVERY'`. All prior unused codes invalidated — user must be notified in Epic 3.

#### AC-9e: Transactional regenerate (concurrency + rollback safety)

`regenerateRecoveryCodes()` **must** run in a **single DB transaction** (mirror AC-6h):

1. `SELECT ... FROM mfa_enrollments WHERE user_id = ? AND status = 'confirmed' FOR UPDATE`
2. Decrypt secret — validate TOTP via `validateTotpCode()`; `recordTotpUse()` on success
3. Mark **all** unused codes `used_at = NOW()`
4. Insert new batch of hashed codes
5. Audit `MFA_RECOVERY_CODES_REGENERATED`
6. Commit

**Rollback rule:** Any failure before commit leaves old codes valid (AC-9a). Never partially invalidate codes.

Use `countUnusedRecoveryCodes()` from `recovery-codes.ts` for audit payload if needed.

---

### AC-10: Pending Enrollment Cleanup on Session End

**Given** user started enrollment (`pending` row exists) but never verified,
**When** their session is revoked OR expires (Story 1.7 cleanup paths),
**Then** pending `mfa_enrollments` row for that user is **deleted**.

**Implementation — use both (defense in depth):**

| Option | Trigger | Required? |
|---|---|---|
| A | Lazy: delete pending rows older than 24h via pg-boss job `mfa:prune-pending` daily | Yes |
| B | Eager: hook into `cleanupExpiredSession()` / session revoke in Story 1.7 — delete pending row for `user_id` immediately | Yes |

Option B closes the hijacked-session window without waiting 24h. Document chosen hook in `mfa.ts` or `session-revoke.ts`.

**Minimum requirement (epics AC):** Integration test proves pending enrollment does not survive 24h+ without confirmation.

**Integration tests:**

1. Create pending enrollment → simulate 25h age (fake timers or DB update) → run prune job → pending row gone; user still has `mfa_enrolled_at IS NULL`
2. Create pending enrollment → revoke session (Story 1.7) → pending row gone immediately (Option B)

---

### AC-11: pg-boss Worker — `prune-totp-used-codes`

**Given** vault unsealed (register in `setOnVaultUnsealed` like Story 1.7),
**When** hourly cron fires,
**Then** delete from `totp_used_codes` where `expires_at < NOW()`.

```typescript
await boss.schedule('mfa:prune-totp-used-codes', '0 * * * *', {}, { tz: 'UTC' })
```

**Integration test:** Insert expired row → run handler → row deleted; future row preserved.

---

### AC-12: Encryption — TOTP Secret at Rest

**Given** vault is unsealed with primary encryption key loaded,
**When** any TOTP secret is persisted,
**Then**:

- Stored as JSONB `EncryptedValue` `{ version, iv, ciphertext, tag }` from `packages/crypto`
- Encrypted with **primary vault key** (same as secret storage — Story 1.5)
- Compromised DB without master key reveals no TOTP secrets

**Integration test:** Insert encrypted enrollment → read raw JSONB from DB → assert no base32 secret substring present → decrypt via service returns valid secret for validation.

---

### AC-13: Zod Schemas & OpenAPI

**Add to `apps/api/src/modules/auth/schema.ts`:**

```typescript
export const mfaEnrollResponseSchema = z.object({
  data: z.object({
    enrollmentId: z.uuid(),
    otpauthUrl: z.string().url(),
    secret: z.string().min(16).max(64),
    qrCodeSvg: z.string().startsWith('<svg'),
  }),
})

export const mfaVerifyEnrollmentBodySchema = z.object({
  totp: z.string().regex(/^\d{6}$/, 'TOTP must be exactly 6 digits'),
})

export const mfaRecoverBodySchema = z.object({
  email: z.email(),
  password: z.string().min(12).max(128),
  recoveryCode: z.string().min(10).max(16),  // pre-normalize; hyphen/spaces optional (AC-8d)
})

export const mfaRecoverResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    expiresAt: z.iso.datetime(),
    remainingRecoveryCodes: z.number().int().min(0),
  }),
})

export const authMeResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    sessionId: z.uuid(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),  // match Story 1.7
    mfaEnrolled: z.boolean(),
    mfaEnrolledAt: z.iso.datetime().nullable(),
    remainingRecoveryCodesCount: z.number().int().min(0).nullable(),  // null when not enrolled
  }),
})

export const mfaRegenerateBodySchema = mfaVerifyEnrollmentBodySchema
```

**And** mirror contracts in `packages/shared` if other apps consume them (follow Story 1.6 pattern).

---

### AC-14: Audit Event Constants

**Extend `packages/shared/src/constants/audit-events.ts`:**

```typescript
export const AuditEvent = {
  // ... existing from 1.6
  MFA_ENROLLMENT_STARTED: 'MFA_ENROLLMENT_STARTED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_RECOVERY_USED: 'MFA_RECOVERY_USED',
  MFA_RECOVERY_CODES_REGENERATED: 'MFA_RECOVERY_CODES_REGENERATED',
} as const
```

**Hardcode prohibition:** ESLint / grep CI already flags raw strings — follow Story 1.6.

---

### AC-15: Dependencies

**Add to `apps/api/package.json`:**

| Package | Version | Purpose |
|---|---|---|
| `otpauth` | `^9.5.1` | RFC 6238 TOTP — architecture mandated |
| `qrcode` | `^1.5.4` | Server-side SVG QR generation |
| `bcrypt` | `^5.1.1` | Recovery code hashing (NOT Argon2 — short-lived random codes) |

**Do NOT add `speakeasy`** — architecture specifies `otpauth`.

**Types:** `@types/bcrypt`, `@types/qrcode` as devDependencies if needed.

---

### AC-16: Logging & Redaction

**Extend Pino redact config:**

```typescript
redact: [
  // ... existing from 1.6/1.10
  'req.body.totp',
  'req.body.recoveryCode',
  'req.body.secret',
  'res.body.data.secret',
  'res.body.data.otpauthUrl',
  'res.body.data.qrCodeSvg',
  'res.body.data.recoveryCodes',
]
```

**Integration test:** Enroll + verify flow → capture log output → assert no 6-digit TOTP, no recovery code strings, no base32 secret.

---

### AC-17: Integration Tests — Required Coverage

**File:** `apps/api/src/__tests__/mfa-enrollment.test.ts` (or split files)

| # | Test case | Assert |
|---|---|---|
| 1 | Full enrollment happy path | enroll → verify with valid TOTP → `mfa_enrolled_at` set → 10 codes returned |
| 2 | Invalid TOTP on verify | 422 `invalid_totp`; pending row deleted |
| 3 | TOTP replay | Same code twice in same window → second fails |
| 4 | Clock skew | Code from previous 30s window accepted (`window: 1`) |
| 5 | Already enrolled | Second `/enroll` → 409 `mfa_already_enrolled` |
| 6 | Recover login happy path | enroll → verify → recover with code → cookies set → `/auth/me` works |
| 7 | Recovery code single-use | Second recover with same code → 401 |
| 8 | Regenerate codes | Old code invalid; new codes work; audit row written |
| 9 | Regenerate without valid TOTP | 422; old codes still valid |
| 10 | Pending enrollment prune | Pending row removed after TTL/job |
| 11 | Unauthenticated enroll | 401 |
| 12 | Recover without MFA enrolled | 401 `invalid_credentials` |
| 13 | Encrypted secret at rest | Raw DB has no plaintext base32 |
| 14 | POST-only | GET `/mfa/enroll` → 405 |
| 15 | Timing — unknown email recover | Response time within 2x of known email (smoke test) |
| 16 | Concurrent verify enrollment | Two parallel valid TOTP submits → exactly one `200` |
| 17 | Concurrent recover same code | Two parallel valid recover → one `200`, one `401` |
| 18 | Recover per-email rate limit | 6th request / 15 min same email → `429` (IP limit not yet hit) |
| 19 | `/auth/me` after enroll | `remainingRecoveryCodesCount === 10` |
| 20 | Recover success body | `remainingRecoveryCodes === 9` after one code consumed |
| 21 | Recover `429` | `Retry-After` header + `retryAfterSeconds` in body |
| 22 | Pending cleanup on session revoke | Revoke session → pending enrollment row deleted immediately (AC-10 Option B) |

**Test helper — TOTP generation:**

```typescript
import * as OTPAuth from 'otpauth'

export function totpForSecret(base32: string): string {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(base32),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  })
  return totp.generate()
}
```

**Use real TOTP from enroll response `secret` field in tests** — do not mock `otpauth`.

---

### AC-18: Unit Tests

| File | Coverage |
|---|---|
| `recovery-codes.test.ts` | Format `XXXXX-XXXXX`; charset excludes ambiguous chars; normalize (AC-8d input table) |
| `totp.test.ts` | validateTotpCode window edges; replay hash stable |
| `mfa.test.ts` | Service-level error mapping (mock DB optional for pure logic) |

---

### AC-19: `GET /api/v1/auth/me` Extension

**Required** — extend Story 1.7 `/auth/me` response:

```json
{
  "data": {
    "userId": "...",
    "orgId": "...",
    "sessionId": "...",
    "orgRole": "owner",
    "mfaEnrolled": true,
    "mfaEnrolledAt": "2026-06-24T12:00:00.000Z",
    "remainingRecoveryCodesCount": 7
  }
}
```

**Field semantics:**

- `mfaEnrolled`: `true` when `mfa_enrolled_at IS NOT NULL`
- `remainingRecoveryCodesCount`: unused code count when enrolled; **`null`** when not enrolled
- Authenticated only — never expose on public endpoints

**Purpose:** Frontend settings + monitoring surfaces know enrollment state and recovery-code runway without burning a code or calling regenerate.

---

### AC-20: Architecture Decision Records

#### ADR-1.8-01: `mfa_enrollments` table vs columns on `users`

**Decision:** Separate table with `pending`/`confirmed` status.  
**Rationale:** Architecture multi-device roadmap; pending state isolation.  
**Rejected:** `users.totp_secret_encrypted` — blocks multi-device, mixes pending with confirmed.

#### ADR-1.8-02: bcrypt for recovery codes, Argon2id for passwords

**Decision:** bcrypt cost 12 for recovery codes.  
**Rationale:** Architecture explicitly specifies bcrypt for recovery codes; codes are high-entropy random (unlike user-chosen passwords).

#### ADR-1.8-03: Recovery login in 1.8, MFA login step in 1.12

**Decision:** `/mfa/recover` issues full JWT immediately.  
**Rationale:** Recovery codes **replace** TOTP for that login — not a second step. Story 1.12 adds TOTP challenge on normal password login when MFA enrolled.

#### ADR-1.8-04: Keep consumed recovery code rows

**Decision:** Set `used_at`, do not DELETE.  
**Rationale:** Audit count of remaining codes; FR102 trail in Epic 8.

#### ADR-1.8-05: Discard pending enrollment on failed verify

**Decision:** Delete pending row on any failed verify attempt.  
**Rationale:** Epics AC; limits brute-force window on a single secret.

#### ADR-1.8-06: Dedicated TOTP replay HMAC secret

**Decision:** Require `TOTP_REPLAY_HMAC_SECRET` in production; no reuse of `REFRESH_TOKEN_HMAC_SECRET`.  
**Rationale:** Red Team — secret compromise isolation; replay table and refresh binding must not share one key.

#### ADR-1.8-07: Dual rate limits on `/mfa/recover`

**Decision:** Per-IP (10/15min) **and** per-email (5/15min).  
**Rationale:** Attacker with stolen password could exhaust all 10 recovery codes in one IP window without per-email cap.

#### ADR-1.8-08: Eager + lazy pending enrollment cleanup

**Decision:** Option A (24h prune job) **and** Option B (delete on session revoke).  
**Rationale:** Red Team — hijacked session should not leave pending MFA enrollment for 24h.

#### ADR-1.8-09: Expose remaining recovery code count

**Decision:** Return `remainingRecoveryCodes` on recover success and `remainingRecoveryCodesCount` on `/auth/me`.  
**Rationale:** User Persona Focus Group — Sam/Morgan need proactive visibility without consuming codes; count is not secret (entropy is in codes themselves).

#### ADR-1.8-10: Transactional regenerate with rollback safety

**Decision:** AC-9e — all code invalidation + reissue in one transaction; failure leaves old codes valid.  
**Rationale:** Critique and Refine — partial invalidation on error would lock users out.

---

## Tasks / Subtasks

- [x] **Task 1: Database migration & Drizzle schemas** (AC: 4)
  - [x] Add `users.mfa_enrolled_at`
  - [x] Create `mfa_enrollments`, `mfa_recovery_codes`, `totp_used_codes`
  - [x] Update `check-rls-coverage.ts` EXCLUDED_TABLES
  - [x] Run `pnpm --filter @project-vault/db db:migrate` locally

- [x] **Task 2: Dependencies & env** (AC: 3, 15)
  - [x] Add `otpauth`, `qrcode`, `bcrypt` to `apps/api`
  - [x] Extend `env.ts` incl. `TOTP_REPLAY_HMAC_SECRET`, `.env.example`, `check-env-example.ts`

- [x] **Task 3: Core MFA modules** (AC: 5, 6, 7, 9)
  - [x] Implement `totp.ts`, `recovery-codes.ts` (incl. `countUnusedRecoveryCodes`, `deletePendingEnrollmentForUser`), `mfa.ts`
  - [x] Transactional verify (AC-6h) + transactional regenerate (AC-9e); `MFA_ENROLLMENT_STARTED` audit on enroll
  - [x] Wire routes with `authenticate` preHandler (except recover)
  - [x] Extend audit constants + `writeAuditEntry` calls

- [x] **Task 4: Recovery login** (AC: 8)
  - [x] Implement `/mfa/recover` reusing session creation from 1.6
  - [x] Add `POST /api/v1/auth/mfa/recover` to vault guard allowlist; dual rate limits (IP + email)
  - [x] `SELECT FOR UPDATE` on recovery code consumption; failed-recover audit
  - [x] Return `remainingRecoveryCodes` on success; `429` with `Retry-After` (AC-8k)

- [x] **Task 5: Background jobs** (AC: 10, 11)
  - [x] `prune-totp-used-codes.ts` hourly worker
  - [x] `prune-mfa-pending.ts` daily worker (24h pending TTL)
  - [x] Hook `deletePendingEnrollmentForUser()` into session revoke (Option B)

- [x] **Task 6: Testing** (AC: 17, 18)
  - [x] Integration test suite with real TOTP codes (incl. #16–22)
  - [x] Unit tests for code generation/normalization
  - [x] Log redaction test
  - [x] Update `route-audit.test.ts`

- [x] **Task 7: `/auth/me` extension** (AC: 19)
  - [x] Add `mfaEnrolled`, `mfaEnrolledAt`, `remainingRecoveryCodesCount`

---

## Dev Notes

### Production Deploy Warning

**Do not deploy Story 1.8 without Story 1.12** to any environment where real users authenticate. Until 1.12 ships, MFA-enrolled users can still log in with **password only** on `/login` — MFA adds enrollment and recovery paths but does not gate normal login.

Safe staging order: 1.8 → 1.12 → enable MFA for test accounts.

### Reuse Checklist (Do Not Reinvent)

| Need | Reuse from |
|---|---|
| Password verify | `@project-vault/crypto` / Story 1.6 `verifyPassword()` |
| Session + cookie issuance | Story 1.6 `setAuthCookies()`, `createSession()` |
| Auth middleware | Story 1.7 `authenticateRequest` |
| Audit write | `apps/api/src/modules/audit/write-entry.ts` |
| Encrypt TOTP secret | `encrypt()` from `@project-vault/crypto` |
| Primary key access | Story 1.5 vault key service `getPrimaryKey()` |
| Platform tx for identity tables | Same pattern as `sessions`/`refresh_tokens` in 1.6 |
| Org-scoped audit | `withOrg(authContext.orgId, tx => ...)` |
| Error response shape | `{ code, message, details? }` — never `{ error }` |
| Email normalization | Story 1.6 AC-32 NFKC + ASCII |
| Dummy hash timing | Story 1.6 `AUTH_DUMMY_PASSWORD_HASH` on unknown user |
| Unused recovery code count | `countUnusedRecoveryCodes()` in `recovery-codes.ts` — used by `/auth/me`, recover response, audit |

### Project Structure Notes

- MFA logic lives in `modules/auth/mfa.ts` — architecture shows `mfa.ts` under auth module [Source: architecture.md#Complete-Project-Directory-Structure]
- Do **not** create `modules/mfa/` top-level module in v1
- Frontend routes `(auth)/mfa/` are **out of scope** — API only

### Testing Standards

- Vitest + real PostgreSQL test DB (Story 1.3/1.4 pattern)
- Use `buildTestApp()` helper from `apps/api/src/__tests__/helpers/`
- Vault must be unsealed in `beforeEach`
- Cleanup order: `totp_used_codes` → `mfa_recovery_codes` → `mfa_enrollments` → (existing 1.6 order)
- Fake timers for prune jobs

[Source: _bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md#Testing-Standards]

---

### Previous Story Intelligence

#### From Story 1.7 (Sessions & Auth Middleware)

- Protected routes use `preHandler: [fastify.authenticate]`
- `authContext.userId`, `authContext.orgId` available on request
- Error codes: `access_token_missing`, `session_revoked`, etc.
- pg-boss jobs register in `setOnVaultUnsealed` callback

#### From Story 1.6 (Auth Foundation)

- Cookie names: `access-token`, `refresh-token`
- Login creates session with `org_id` from primary membership
- POST-only auth routes — extend to MFA
- Rate limiting via `@fastify/rate-limit`

#### From Story 1.5 (Vault & Crypto)

- `encrypt()` for outbound encryption; `withSecret()` for inbound decryption
- Vault sealed → all auth blocked including MFA

#### From Story 1.4 (Database)

- `audit_log_entries` canonical name
- Identity-scoped tables exempt from org RLS

---

### Git Intelligence

Branch `feature/1-5-vault-initialization-and-master-key-management` has vault + crypto in progress; auth module (1.6) may be spec-only until merged.

**Before starting 1.8:** Verify `apps/api/src/modules/auth/` exists with 1.6 + 1.7 implementation. If missing, complete prerequisites first — 1.8 is not standalone.

---

### Latest Technical Information

**otpauth 9.5.1** (Apr 2026): Use `TOTP.validate({ token, window })` where `window: 1` allows ±1 period skew. Default algorithm SHA1 for authenticator app compatibility. [Source: https://www.npmjs.com/package/otpauth]

**qrcode 1.5.x:** `QRCode.toString(url, { type: 'svg' })` produces embeddable SVG without external services.

**bcrypt 5.x:** Async `hash`/`compare` — use `await bcrypt.compare(normalized, hash)` in constant-time loop over user's unused codes.

---

### UX Principles (API Contract for Future UI)

Per UX-DR3 [Source: ux-design-specification.md]:

- MFA enrollment flow must treat **recovery code backup as primary content**, not a footnote
- Correct path = default path: encourage saving codes before dismissing modal
- API returns codes once — UI must implement confirmation gate client-side
- **Contextual education at the decision point** — see AC-6i for persona-driven copy requirements

**Suggested UI flow (not implemented in 1.8):**

1. Settings → Security → Enable MFA
2. Show QR + manual secret + AC-6i pre-verify warning
3. User enters 6-digit code
4. Full-screen recovery codes + mandatory checkbox "I have saved these codes"
5. Redirect to dashboard; `/auth/me` shows `remainingRecoveryCodesCount: 10`

**Monitoring surfaces (Sam persona):** When `remainingRecoveryCodesCount ≤ 2`, show persistent Security settings warning. No separate API endpoint needed.

### MFA Lockout Runbook (Epic UI copy)

| Situation | User action | System path |
|---|---|---|
| Lost authenticator, has recovery codes | Sign in with recovery code (`/mfa/recover`) | Story 1.8 |
| Lost authenticator, no recovery codes left | Contact org Owner/Admin | Epic 4.3 admin recovery (FR56) |
| Wrong TOTP during enrollment | Restart enrollment (scan new QR) | AC-6c — by design |
| Regenerated codes without saving new set | Use codes from last regenerate; all prior codes dead | AC-9 |
| Recover rate limited (`429`) | Wait for `retryAfterSeconds`; verify code format | AC-8k |

---

### Accepted Security Risks (v1)

| Risk | Mitigation | Owner |
|---|---|---|
| Enrollment `secret` exposed to XSS during setup | Short-lived session; HttpOnly cookies for auth; CSP in web app | Web Epic |
| Session hijack enrolls attacker TOTP (no step-up) | Audit `MFA_ENROLLMENT_STARTED`; pending cleanup on revoke; rate limits | 1.8 / 1.9 |
| Password + recovery code online guessing (10 codes, 10 tries/IP) | Per-email rate limit (5/15min); Epic 3 alert on use; user education | 1.8 / Epic 3 |
| MFA enrolled but login not gated (pre-1.12) | Deploy 1.8+1.12 together in prod | Release process |
| No MFA disable endpoint | By design — recovery codes + regenerate only | Product |
| Recovery codes shown in API response (HTTPS only) | TLS required in prod; no logging | 1.8 |
| bcrypt compare loops all unused codes | Max 10–16 codes — acceptable | 1.8 |
| `failed_auth_attempts` not recorded for bad TOTP | Story 1.9 | 1.9 |
| Email alert on recovery use deferred | Audit + `alert.pending_epic3` log | Epic 3 |

---

### Out of Scope (Explicit)

| Item | Owner story |
|---|---|
| MFA challenge on normal login (`mfaRequired`, `mfaToken`) | 1.12 |
| MFA role enforcement (`requireMfa` flag) | 1.9 |
| `failed_auth_attempts` table + threshold detection | 1.9 |
| Admin-initiated account recovery (FR56) | Epic 4.3 |
| MFA disable / unenroll | Not planned v1 |
| Web UI enrollment screens | Architecture step 7 |
| Multi-device MFA (multiple confirmed enrollments) | Post-v1 |
| WebAuthn / FIDO2 | Post-v1 |

---

### Anti-Patterns (Do Not)

- Store TOTP secret plaintext in DB or logs
- Use `users.mfa_enrolled` boolean — use `mfa_enrolled_at` timestamptz
- Put TOTP secret on `users` row — use `mfa_enrollments`
- Use Argon2id for recovery codes — use bcrypt
- Use `speakeasy` instead of `otpauth`
- Call external QR code API (Google Chart, etc.)
- Return recovery codes from any endpoint except verify-enrollment and regenerate
- Accept TOTP in query string or GET request
- Skip replay protection (`totp_used_codes`)
- Use `{ error: 'invalid_totp' }` — use `{ code: 'invalid_totp' }`
- Log `req.body.totp` or recovery codes
- Log enroll response fields (`otpauthUrl`, `qrCodeSvg`, `secret`) — see AC-16 redact paths
- Decrypt TOTP secret outside `withSecret()` / short-lived buffer
- Allow `/mfa/recover` without vault unsealed
- Query MFA tables from modules outside `auth/`
- Issue full JWT on `/mfa/enroll` or `/verify-enrollment` — only on recover (login) or existing login flow
- Implement Story 1.12 login MFA gate in this story
- Store raw 6-digit TOTP in `totp_used_codes` — store HMAC hash only
- Skip audit write on successful enrollment/recovery
- Reveal whether email exists on recover endpoint — unified 401 message
- Reuse `REFRESH_TOKEN_HMAC_SECRET` for TOTP replay in production
- Consume recovery codes without `SELECT FOR UPDATE` in a transaction
- Ship 1.8 to production without 1.12 login MFA gate
- Skip `MFA_ENROLLMENT_STARTED` audit on enroll

---

### Manual QA Checklist

```bash
# 1. Login and start enrollment
curl -s -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@test.com","password":"twelve-characters"}'

curl -s -b cookies.txt -X POST http://localhost:3000/api/v1/auth/mfa/enroll \
  -H 'Content-Type: application/json' -d '{}' | jq '.data | {enrollmentId, secret}'

# 2. Generate TOTP locally (use secret from step 1) and verify
# totp=$(node -e "const OTPAuth=require('otpauth'); ...")
curl -s -b cookies.txt -X POST http://localhost:3000/api/v1/auth/mfa/verify-enrollment \
  -H 'Content-Type: application/json' \
  -d "{\"totp\":\"$totp\"}" | jq '.data.recoveryCodes'

# 3. Recovery login (new session, no TOTP)
curl -s -c cookies2.txt -X POST http://localhost:3000/api/v1/auth/mfa/recover \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@test.com","password":"twelve-characters","recoveryCode":"FIRST-CODE"}' | jq '.data | {userId, remainingRecoveryCodes}'

curl -s -b cookies2.txt http://localhost:3000/api/v1/auth/me | jq '.data | {mfaEnrolled, remainingRecoveryCodesCount}'

# 4. POST-only
curl -s -o /dev/null -w '%{http_code}' -b cookies.txt http://localhost:3000/api/v1/auth/mfa/enroll
# → 405
```

---

### References

- Epic AC: [_bmad-output/planning-artifacts/epics.md#Story-1.8-TOTP-MFA-Enrollment--Recovery-Codes_]
- FR54, FR55: [_bmad-output/planning-artifacts/prd.md#Functional-Requirements_]
- MFA architecture: [_bmad-output/planning-artifacts/architecture.md#Authentication--Security_]
- Canonical schema: [_bmad-output/planning-artifacts/architecture.md#Canonical-Schema-Entity-Names_]
- Audit events: [_bmad-output/planning-artifacts/architecture.md — AuditEvent enum_]
- UX security flows: [_bmad-output/planning-artifacts/ux-design-specification.md#Design-Challenges_]
- Crypto patterns: [_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md_]
- Auth patterns: [_bmad-output/implementation-artifacts/1-6-user-registration-and-password-authentication.md_]
- Auth middleware: [_bmad-output/implementation-artifacts/1-7-jwt-session-management-and-security-controls.md_]
- otpauth docs: [https://github.com/hectorm/otpauth](https://github.com/hectorm/otpauth)

---

## Dev Agent Record

### Agent Model Used

GPT-5.5

### Debug Log References

- 2026-06-26: Task 1 red check added to `packages/db/src/schema/auth-sessions-schema.test.ts`; narrow schema test failed on missing `users.mfaEnrolledAt` and MFA RLS exclusions as expected.
- 2026-06-26: Started local Postgres with `docker compose up -d db`; ran `pnpm --filter @project-vault/db db:migrate` successfully.
- 2026-06-26: Re-ran `pnpm --filter @project-vault/db exec vitest run src/schema/auth-sessions-schema.test.ts` successfully.
- 2026-06-26: Task 2 red check added to `apps/api/src/config/env.test.ts`; focused env test failed on missing MFA env defaults and production replay-secret validation as expected.
- 2026-06-26: Installed `otpauth`, `qrcode`, `bcrypt`, `@types/qrcode`, and `@types/bcrypt`; `pnpm` ignored the `bcrypt` build script, but a focused Node smoke test confirmed `bcrypt` hash/compare works.
- 2026-06-26: Ran `pnpm --filter @project-vault/api exec vitest run src/config/env.test.ts` and `pnpm exec tsx scripts/check-env-example.ts` successfully.
- 2026-06-26: Task 3 red checks added for MFA audit constants, recovery-code helpers, TOTP helpers, and MFA protected route wiring; tests failed on missing constants/modules/routes as expected.
- 2026-06-26: Ran `pnpm --filter @project-vault/api exec vitest run src/modules/auth/routes.test.ts src/modules/auth/recovery-codes.test.ts src/modules/auth/totp.test.ts` successfully.
- 2026-06-26: Ran `pnpm --filter @project-vault/shared exec vitest run src/constants/audit-events.test.ts`, `pnpm --filter @project-vault/db build`, `pnpm --filter @project-vault/shared build`, and `pnpm --filter @project-vault/api typecheck` successfully.
- 2026-06-26: Task 4 route coverage added for public `/mfa/recover` validation and POST-only behavior.
- 2026-06-26: Ran `pnpm --filter @project-vault/api exec vitest run src/modules/auth/routes.test.ts`, `pnpm --filter @project-vault/api typecheck`, and `pnpm --filter @project-vault/api exec vitest run src/plugins/vault-guard.test.ts` successfully.
- 2026-06-26: Task 5 added `mfa:prune-totp-used-codes` hourly worker, `mfa:prune-pending` daily worker, and pending-enrollment deletion inside `revokeSessionById()`.
- 2026-06-26: Ran `pnpm --filter @project-vault/api exec vitest run src/modules/auth/session-revoke.test.ts` and `pnpm --filter @project-vault/api typecheck` successfully.
- 2026-06-26: Task 6 added MFA integration coverage with real TOTP generation, recovery-code single-use assertion, log redaction coverage, and route-audit public exemption for `/mfa/recover`.
- 2026-06-26: Added `0008_mfa_foundation` to Drizzle migration journal after discovering drizzle-kit did not apply the manual SQL file without a journal entry; reran `pnpm --filter @project-vault/db db:migrate` successfully.
- 2026-06-26: Ran `pnpm --filter @project-vault/api exec vitest run src/__tests__/auth-log-redaction.test.ts src/__tests__/mfa-enrollment.test.ts src/modules/auth/recovery-codes.test.ts src/modules/auth/totp.test.ts src/modules/auth/routes.test.ts src/plugins/vault-guard.test.ts` successfully.
- 2026-06-26: Ran `pnpm --filter @project-vault/shared exec vitest run src/constants/audit-events.test.ts` successfully.
- 2026-06-26: Expanded `mfa-enrollment.test.ts` to cover `/auth/me` MFA state after enrollment/recovery, concurrent recovery-code redemption, recover `429` `Retry-After`, and pending enrollment cleanup on session revoke.
- 2026-06-26: Ran `pnpm --filter @project-vault/api exec vitest run src/__tests__/auth-log-redaction.test.ts src/__tests__/mfa-enrollment.test.ts src/modules/auth/recovery-codes.test.ts src/modules/auth/totp.test.ts src/modules/auth/routes.test.ts src/plugins/vault-guard.test.ts src/modules/auth/session-revoke.test.ts`, `pnpm --filter @project-vault/api typecheck`, and `pnpm --filter @project-vault/shared exec vitest run src/constants/audit-events.test.ts` successfully.
- 2026-06-26: Ran `pnpm typecheck` successfully.
- 2026-06-26: Ran `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault ADMIN_DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault VAULT_ALLOW_REMOTE_INIT=true pnpm test` successfully.
- 2026-06-26: Ran targeted ESLint for touched API files successfully (one pre-existing warning remains in `redact-secrets.ts`); full `pnpm lint` still fails on unrelated pre-existing repo-wide lint errors under `.claude/skills` and other legacy files.

### Completion Notes List

- Task 1 complete: added `users.mfa_enrolled_at`, identity-scoped MFA enrollment/recovery/replay tables, Drizzle exports, RLS coverage exclusions, and migration `0008_mfa_foundation.sql`.
- Task 2 complete: added MFA dependencies, env defaults/production guardrails, `.env.example` entries, and explicit env-example checker coverage for Story 1.8 MFA variables.
- Task 3 complete: added TOTP/recovery-code helpers, transactional enroll/verify/regenerate service methods, protected MFA routes, and Story 1.8 audit event constants.
- Task 4 complete: added public recovery-code login, dual in-memory rate limits, transactional recovery-code consumption/session creation/audit, recovery response count, and vault-guard allowlist entry.
- Task 5 complete: added MFA cleanup workers, registered pg-boss schedules after vault unseal, and hooked pending-enrollment cleanup into session revocation.
- Task 6 complete: added focused integration/unit/route/log-redaction coverage for MFA enrollment, recovery, helper behavior, and public route governance.
- Task 7 complete: extended `/auth/me` with `mfaEnrolled`, `mfaEnrolledAt`, and `remainingRecoveryCodesCount`; integration coverage verifies counts after enrollment and recovery.

### File List

- `_bmad-output/implementation-artifacts/1-8-totp-mfa-enrollment-and-recovery-codes.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `.env.example`
- `apps/api/package.json`
- `apps/api/src/app.ts`
- `apps/api/src/__tests__/auth-log-redaction.test.ts`
- `apps/api/src/__tests__/mfa-enrollment.test.ts`
- `apps/api/src/__tests__/sessions.integration.test.ts`
- `apps/api/src/config/env.test.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/modules/auth/mfa.ts`
- `apps/api/src/modules/auth/recovery-codes.test.ts`
- `apps/api/src/modules/auth/recovery-codes.ts`
- `apps/api/src/modules/auth/routes.test.ts`
- `apps/api/src/modules/auth/routes.ts`
- `apps/api/src/modules/auth/schema.ts`
- `apps/api/src/modules/auth/session-revoke.ts`
- `apps/api/src/modules/auth/totp.test.ts`
- `apps/api/src/modules/auth/totp.ts`
- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/main.ts`
- `apps/api/src/plugins/vault-guard.ts`
- `apps/api/src/plugins/redact-secrets.ts`
- `apps/api/src/workers/prune-mfa-pending.ts`
- `apps/api/src/workers/prune-totp-used-codes.ts`
- `apps/api/src/__tests__/route-audit.test.ts`
- `apps/api/src/modules/vault/key-service.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `packages/db/src/check-rls-coverage.ts`
- `packages/db/src/migrations/0008_mfa_foundation.sql`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/auth-sessions-schema.test.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/mfa-enrollments.ts`
- `packages/db/src/schema/mfa-recovery-codes.ts`
- `packages/db/src/schema/totp-used-codes.ts`
- `packages/db/src/schema/users.ts`
- `packages/shared/src/constants/audit-events.test.ts`
- `packages/shared/src/constants/audit-events.ts`
- `scripts/check-env-example.ts`

### Change Log

- 2026-06-26: Started Story 1.8 implementation and completed Task 1 database migration/Drizzle schema foundation.
- 2026-06-26: Completed Task 2 dependency and MFA environment configuration.
- 2026-06-26: Completed Task 3 core MFA modules, protected routes, and audit constants.
- 2026-06-26: Completed Task 4 recovery-code login flow, vault allowlist, and rate-limit response handling.
- 2026-06-26: Completed Task 5 cleanup workers and pending-enrollment session-revoke hook.
- 2026-06-26: Completed Task 6 MFA test coverage and log redaction updates.
- 2026-06-26: Completed Task 7 `/auth/me` MFA status extension.
