# Epic 17 — External-Share Token Model: Security Review

**Date:** 2026-07-27
**Scope:** Design-level security review of the tokenized external-share link mechanism
(FR122–FR125, `sprint-change-proposal-2026-07-24.md` §4.2 New Epic 17) required by
`sprint-status.yaml`'s `epic-17` gate before any Epic 17 story creation begins. This is
Project Vault's first unauthenticated-access-to-secret-material pathway.
**Status:** Gate cleared — see Verdict.

---

## 1. Proposed Token Model (design under review)

### 1.1 Token generation

- Token is a cryptographically random 256-bit value (`crypto.randomBytes(32)`), base64url-encoded
  for URL safety. Never derived from any predictable input (share ID, timestamp, credential ID).
- The token itself is the sole bearer credential for the share — knowledge of the token is
  sufficient to reach the reveal flow. It is **never logged**, not in application logs, access
  logs, or error traces. Only its SHA-256 hash is persisted (`shares.token_hash`), so a database
  leak alone does not yield usable tokens — this mirrors the existing pattern for
  password-reset/invite tokens elsewhere in the codebase.
- The share record stores: `id`, `credential_id`, `field_key` (nullable — null means whole-secret),
  `token_hash`, `created_by`, `recipient_type` (`member` | `external`), `recipient_ref` (user_id or
  email), `expires_at`, `single_use` (bool, default true), `status`
  (`pending`|`viewed`|`revoked`|`expired`|`superseded`), `created_at`, `viewed_at`.

### 1.2 Single-use / expiry enforcement

- Every token lookup happens inside the same advisory-lock-guarded transaction pattern already
  used for rotation state transitions (Story 5.6) — the status check and status flip to `viewed`
  are atomic, closing the double-redemption race a naive check-then-update would have.
- `expires_at` is enforced both at query time (WHERE clause excludes expired rows) and via a
  scheduled sweep that flips stale `pending` shares to `expired` (consistent with existing
  scheduled-job conventions), so an expired token reads as fully gone even if the sweep hasn't run
  yet.
- Default expiry is configurable per share at creation time, bounded by an org-level maximum
  (mirrors the existing `system_settings` singleton pattern used for `maxOrgs` etc.) so no org can
  configure indefinite-lived external links.

### 1.3 Consent-gated reveal (anti-prefetch)

- The link's first GET renders a consent screen only — no secret material in that response, no
  secret material reachable via any pre-rendered/pre-fetched resource on that page. Reveal happens
  only on a subsequent explicit POST triggered by a human click, which is the point at which
  `single_use` is enforced and `status` flips.
- This directly defeats automated link-unfurling (chat-client previews, "safe link" rewriting
  proxies, email prefetchers) silently burning the single-use token before the intended recipient
  ever sees it — a documented, real-world failure mode for single-use share links.
- Both the consent GET and the reveal POST set `Cache-Control: no-store, no-cache` and
  `Pragma: no-cache` — no intermediate cache or browser back/forward cache may retain the response.

### 1.4 Authentication asymmetry (member vs. external)

- **Member shares (17.1):** recipient must be an authenticated org member; access is checked
  against normal RLS/session auth, not the token alone — the token is a routing/notification
  mechanism, not a bearer credential, since the recipient's own session already gates access.
- **External shares (17.2):** the token *is* the sole gate, since there is no account to
  authenticate. This is the higher-risk path and gets the additional controls in 1.5.

### 1.5 External-share hardening (17.2-specific, already specified in the sprint-change-proposal)

- Creating an external share requires the **sharer** to step up (re-auth: password or MFA) given
  the sensitivity of minting an unauthenticated access pathway.
- Org admins are notified (via the existing FR100 notification routing) on **both** share creation
  and first view — not creation only — so a compromised sharer account creating silent external
  shares is still visible to admins.
- If the shared field is renamed or removed (Story 13.2 semantics) before the share is
  viewed/expired, the share is automatically transitioned to `expired` rather than left pointing at
  a stale `field_key` — prevents a dangling reference from resolving unpredictably later.

### 1.6 Rate limiting & enumeration resistance

- The reveal endpoint is keyed by token, not by any guessable share ID in the URL path — an
  attacker cannot enumerate shares by walking sequential IDs.
- Failed/invalid token lookups return an identical generic response (whether the token is
  malformed, expired, revoked, or simply never existed) — no oracle for distinguishing "wrong
  token" from "right token, wrong state."
- The reveal/consent endpoints are subject to the existing global rate-limiting middleware, plus a
  per-token attempt cap (a handful of attempts) that flips the share to `revoked` on cap exceeded,
  closing brute-force guessing of a valid-but-unguessed token down to a bounded number of tries.

### 1.7 Audit trail (FR124)

- Every lifecycle event (`created`, `viewed`, `revoked`, `expired`, `superseded`) is written to the
  existing audit-log mechanism, recording actor, timestamp, share ID, and outcome — never the
  secret value itself, consistent with the existing "audit records keys/metadata, never secret
  material" convention already established for rotation audit entries (Story 13-4).

### 1.8 Rotation-recommended nudge & supersession (FR125, Story 17.3)

- Promoting a rotation (Story 5.6) on a credential/field with outstanding shares marks those shares
  `superseded` and clears the "shared — rotation recommended" flag, so the nudge cannot go stale
  relative to an already-completed rotation.

---

## 2. Adversarial Review

Reviewed via the three-layer approach from `bmad-code-review` (Blind Hunter / Edge Case Hunter /
Acceptance Auditor), applied here to the *design* rather than a diff, plus a dedicated attacker-lens
pass given this is an unauthenticated pathway.

### 2.1 Findings

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| F1 | High | Original draft stored the raw token as a query-string param only; if the recipient's browser/network path logs URLs (proxies, browser history, referrer headers on outbound links from the consent page), the token could leak even with `no-store` on the response. | Consent page must not contain any outbound links/resources (images, scripts) to third-party origins that would carry the URL via `Referer`. Add `Referrer-Policy: no-referrer` on both consent and reveal responses. Documented as an explicit AC for 17.2. |
| F2 | High | Single-use enforcement described only "atomic check-then-flip" without naming the mechanism, which risks an implementation using an application-level check that isn't actually atomic under concurrent requests (two tabs opening the same link simultaneously). | Explicitly reuses the same DB-level advisory-lock-guarded transaction pattern as rotation promote/retire (Story 5.6) — same primitive, not a new bespoke lock. Called out in 1.2 above; must be a named AC in 17.2, not left to implementation discretion. |
| F3 | Medium | No stated limit on number of *pending* (unviewed) external shares a single sharer can create — a compromised or malicious account could mint many long-lived external links faster than the per-share expiry limits things. | Add an org-level cap on concurrent pending external shares per credential/field (reuses the `system_settings` singleton pattern already used for other org limits), surfaced to 17.2's AC list. |
| F4 | Medium | Enumeration-resistance (1.6) states failed lookups return an identical response, but didn't originally specify identical *timing* — a timing side-channel (hash lookup vs. no-row-found) could still distinguish valid-but-expired tokens from never-existed ones. | Token lookup must hash the presented token and query by `token_hash` unconditionally (i.e. always perform the hash + query, never short-circuit on format validation before hashing) so response timing doesn't depend on whether a matching hash exists. |
| F5 | Low | The audit trail (1.7) doesn't state whether the *token itself* is excluded from audit log context objects (as opposed to just the secret value) — a verbose logging middleware could inadvertently capture the raw token in a request-context dump. | Explicit AC: any structured request-logging/audit middleware applied to share endpoints must redact the token path parameter/body field by name, not rely on "we don't log secret values" alone. |
| F6 | Low | No explicit statement of what happens to a `pending` external share if the *sharer's* account is deactivated/removed before it's viewed (Story 4.3 account deactivation exists in this codebase). | Deactivating the sharer's account should not silently leave the link live — treat it the same as a manual revoke at deactivation time. Add as a cross-reference AC in 17.2, linking to Story 4.3. |

### 2.2 Attacker-lens pass (no additional findings beyond the above)

Considered and found adequately covered by the model above: token brute-forcing (F4 mitigated,
1.6), replay of a viewed/expired token (status check per 1.2), stale field references after
Story 13.2 field rename (1.5), cache/proxy leakage (1.3, F1), and audit-trail secret leakage (1.7,
F5). No unresolved unauthenticated-access path identified beyond the items in §2.1.

---

## 3. Verdict

**Gate: cleared, conditionally.** The token model in §1 (as amended by the resolutions in §2.1) is
sound to build against. F1–F6 are not blocking further design work, but **F1–F4 must be carried
into 17.2's acceptance criteria as explicit, testable ACs** (not left as prose in this doc) since
they are the findings with real exploitability if silently dropped during story creation. F5–F6
should also be carried forward but are lower urgency.

Epic 17 story creation (starting with 17.1) may now proceed per the standard `pick-story` flow.
17.2 in particular must incorporate F1–F4 as ACs during its own `/bmad-create-story` +
elicitation pass, cross-referencing this document.

---

## 4. Follow-ups tracked

- F1–F6 above: to be incorporated as ACs into Story 17.2 at creation time.
- No new stories needed — all findings are scoped to existing planned stories (17.2 primarily,
  17.1/17.3 unaffected).
