# MFA Policy Matrix

**Status:** Canonical reference (Epic 1 retro P1, Option A)  
**Supersedes:** Epics AC-E1c literal "block login after grace" — see ADR-1.9-05 in `_bmad-output/implementation-artifacts/1-9-mfa-role-enforcement-and-failed-authentication-detection.md`  
**Applies to:** Story creation, code review, Epic 4 FR57 verification, operator docs

---

## Enforcement surfaces

| Surface | Story | Mechanism |
|---------|-------|-----------|
| **Enrollment** | 1.8 | `POST /auth/mfa/enroll` → `verify-enrollment` → `users.mfa_enrolled_at` |
| **Privileged API routes** | 1.9, 1.11 | `requireMfaEnrollment()` / `SecureRoute({ requireMfa: true })` |
| **Login challenge** | 1.12 | `mfa_enrolled_at IS NOT NULL` → `mfaRequired` + `verify-login` |
| **Invite members (FR57)** | 4.1 (planned) | Requires MFA enrolled before `POST .../invitations` |
| **Alert delivery** | Epic 3 | MFA recovery use / codes regenerated → email + inbox via `dispatchDirectUserNotification()`, live since Story 3.4 |

**Grace period:** `MFA_PRIVILEGED_ROLE_GRACE_DAYS` (default **7** days) on `org_memberships.grace_period_expires_at` for new owner/admin.

---

## Alert delivery status (Story 3.4)

| Surface | Status |
|---|---|
| FR73 failed-auth threshold | Live since Story 3.1 |
| MFA recovery used / codes regenerated | Live since Story 3.4 |
| Remaining Epic 3 stub alert markers in `apps/api/src` | **None** — enforced by `scripts/check-alert-pending-epic3.ts` (`make ci`) |

---

## Matrix: user state × surface

| User state | Login (`POST /auth/login`) | Privileged routes | `GET /auth/me` banner | Invite (Epic 4) | Recovery codes |
|------------|----------------------------|-------------------|----------------------|-----------------|----------------|
| Member / viewer | Password → session | Role-gated only (no MFA policy) | No MFA banner | N/A | N/A |
| Owner/admin, **grace active**, no MFA | Password → session | **Allowed** + `X-MFA-Grace-Expires-At` | `gracePeriodActive: true` | Blocked when 4.1 ships | N/A until enrolled |
| Owner/admin, **grace expired**, no MFA | Password → session *(Option A)* | **403 `mfa_required`** | `enrollmentRequired: true` | Blocked when 4.1 ships | N/A until enrolled |
| Owner/admin, **MFA enrolled** | Password → **mfaRequired** → TOTP → session | Allowed if role permits | Enrolled | Allowed when 4.1 ships | `POST /auth/mfa/recover` at login if device lost |
| MFA enrolled, wrong TOTP at login | Challenge remains / expires | — | — | — | After max attempts, restart login |

### Option A decision (Epic 1 retro, 2026-06-30)

**Unenrolled owner/admin after grace** are **not** blocked at login. They receive a full password-only session but cannot perform privileged actions until MFA enrollment completes. This matches ADR-1.9-05 and Story 1.12 scope (login gate for **enrolled** users only).

To move to strict login block (former AC-E1c literal), see Epic 1 retro Option B — **not** chosen.

---

## MFA-exempt routes (must stay ungated)

From Story 1.9 AC-5c — enrollment and status paths:

| Route | Reason |
|-------|--------|
| `POST /auth/mfa/enroll` | Enrollment itself |
| `POST /auth/mfa/verify-enrollment` | Enrollment itself |
| `POST /auth/mfa/regenerate-recovery-codes` | Requires valid TOTP |
| `POST /auth/mfa/verify-login` | Pre-session login step |
| `GET /auth/me` | Grace/enrollment banner source |
| `GET /org/security-alerts` | ADR-1.9-04 — admins in grace must see attacks |

---

## PreHandler order (when role + MFA apply)

```text
authenticate → requireOrgRole → requireMfaEnrollment
```

Members hit `insufficient_role` before MFA queries run.

---

## Security layers at login (enrolled users)

| Layer | Scope | Story |
|-------|-------|-------|
| Per-`mfaToken` attempt cap | Single challenge | 1.12 (`MFA_LOGIN_MAX_ATTEMPTS`) |
| Cross-attempt threshold | Account / IP | 1.9 (`failed_auth_attempts` worker) |
| TOTP replay table | Per enrollment secret | 1.8 |

Known limitation (deferred): re-`POST /auth/login` resets per-token attempt count; cross-token threshold still applies (ADR-1.12-09).

---

## Epic 4 FR57 verification checklist

When Story 4.1 is implemented, verify these matrix rows:

- [ ] Owner/admin **without MFA** cannot `POST /projects/:id/invitations` (even during grace — FR57 is invite-specific; confirm story AC vs grace policy in 4.1)
- [ ] Owner/admin **with MFA enrolled** can invite after full login journey (password → TOTP → session)
- [ ] Integration test `mfa-journey.integration.test.ts` stays green
- [ ] Persona journey in Story 4.1 references this matrix

---

## References

- ADR-1.9-05 — Route-level MFA vs login block: `_bmad-output/implementation-artifacts/1-9-mfa-role-enforcement-and-failed-authentication-detection.md`
- ADR-1.9-04 — Security alerts during grace: same file
- Story 1.12 login branch: `_bmad-output/implementation-artifacts/1-12-mfa-login-verification-flow.md`
- Epics AC-E1c (updated): `_bmad-output/planning-artifacts/epics.md`
