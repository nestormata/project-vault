# Sprint Change Proposal — 2026-07-24

**Project:** Project Vault
**Prepared by:** Bob (Scrum Master persona, via bmad-correct-course)
**Mode:** Batch review
**Trigger:** New stakeholder (Nestor) requirement, surfaced via `/bmad-help`, not a story-execution bug

---

## 1. Issue Summary

Three related but distinct new requirements were raised for the credential/rotation domain, all bundled in one request:

1. **Dependent-location tracking with links** — for each credential, list the concrete places (systems) where its value is configured, optionally with a URL to that location.
2. **Primary/secondary staged rotation** — instead of in-place rotation gated on an all-or-nothing checklist, let the user create a new ("secondary") value while the old ("primary") stays live and servable, update dependent systems at their own pace, then explicitly **promote** the new value and separately, explicitly **delete/retire** the old one — with the UI making old/active vs. new/staged vs. promoted vs. deleted states visually unambiguous at all times.
3. **Temporary secret sharing** — share a credential's current value for a bounded time with an org member or an external (non-member) recipient; track every share (who, with whom, when, expiry, revoked/viewed); flag the credential as "shared — rotation recommended" afterward.

None of these were reported as defects. All three are new-requirement additions layered onto a rotation/credential domain that is partly shipped (Epics 2 and 5, both `done`) and partly still in flight (Epic 13, `in-progress`, two stories `done`, two `backlog`).

---

## 2. Impact Analysis

### 2.1 Epic Impact

| Epic | Status today | Impact |
|---|---|---|
| Epic 2 (credential CRUD, `credential_dependencies`) | done | **Reopened via a follow-up story** — needs a `link_url` column and UI surfacing. Same "completion round 2" convention already used repeatedly in this project (2-9, 4-5, 6-5, 8-6, 9-7...). |
| Epic 5 (Rotation Initiation/Checklist/Completion, Stale Recovery, Break-Glass) | done | **Reopened via a follow-up story** — the confirm-all-then-retire completion model (Story 5.2) is amended into a stage → promote → retire state machine. This is the epic that actually needs redesigning; it is not new territory, it is a change to already-shipped code. |
| Epic 13 (Structured Multi-Field Secrets, in-progress) | 13-1/13-2 done, 13-3/13-4 backlog | Story 13.4 ("Rotate Specific Fields") has not started — it should be **rewritten to build on the new staged state machine rather than the old checklist-then-retire one**, avoiding building on a model about to be replaced. |
| New Epic 17 (proposed) | n/a | Owns temporary secret sharing — no existing epic covers this; it is orthogonal to 13/14/15/16 (no shared backend module with any of them) but depends on Epic 13's `field_key` model for field-scoped sharing of multi-field secrets. |

No epic needs to be removed, and no planned epic (14/15/16) is invalidated. Recommended build order updates from **14 → 13 → 15 → 16** to **14 → 13 → 17 → 15 → 16** (17 has no dependency on 15/16 and no urgency ahead of 13, but should follow 13 since it reuses 13's field-key model).

### 2.2 Artifact Conflicts

**PRD (`prd.md`):**
- FR18/FR21/FR22 need amendment: rotation completion is no longer a single "all confirmed → retire" transaction. It splits into: stage (already implicit in current design — see below), **promote** (explicit, independent of checklist state), and **retire/delete-old** (explicit, independent action, possibly deferred indefinitely).
- FR19/FR104 need a minor amendment: dependency records gain an optional link.
- FR108 (break-glass) needs re-wording, not re-design: break-glass already means "promote + retire old immediately without waiting for confirmations" — the new vocabulary just makes this explicit rather than folding it into one word ("complete").
- New FR group needed for sharing (proposed FR122–FR125, next available after FR121).
- The **v1 Design Decision — Rotation Confirmation Model** (epics.md line 63) is *not* violated by the staged model — that decision is about manual-checklist vs. automated-fingerprint-detection confirmation, which is orthogonal. It should be left in place, and a short note added clarifying that "manual checklist" now feeds a non-blocking promote/retire decision rather than a blocking completion gate.

**Architecture (`architecture.md`):**
- Good news found during this analysis: the data model **already stages a new value while the old stays current** — `current_version_id` only flips inside the completion transaction (line 331), meaning a new `credential_versions` row already exists mid-rotation without the old one being touched. The core primitive the user is asking for is *already half-built*. The gap is entirely in the **state machine and exposure**, not the storage model:
  - Today: only `current_version_id`'s value is servable at all during `in_progress` — the staged value isn't independently retrievable.
  - Today: `rotations.status` enum is `('in_progress','completed','abandoned','stale_recovery','break_glass_complete')` — needs new states, e.g. add `staged` (replaces the meaning of `in_progress`), `promoted`, `retired`, keeping `abandoned`/`stale_recovery`/`break_glass_complete`.
  - Today: one compound transaction does confirm-check + version flip + retire. Needs splitting into two independent transactions: **promote** (flips `current_version_id`, no deletion) and **retire** (cryptographically deletes the old version, only reachable after promote).
  - The advisory-lock-per-credential concurrency mechanism (pg-boss `rotation:*`, `409 ROTATION_IN_PROGRESS`) is reused unchanged — still exactly one active rotation per credential.
  - New audit events needed alongside existing `ROTATION_COMPLETED`/`ROTATION_ABANDONED`: `ROTATION_PROMOTED`, `ROTATION_OLD_RETIRED`, plus a new reveal-audit path for fetching the staged (not-yet-current) value.
  - `rotation:recover`'s existing 1-hour stale threshold is a **crash-recovery** mechanism and must NOT apply to `staged` rotations — under the new model, staying `staged` for days/weeks while an operator works through dependent systems is the intended, healthy path, not a stuck state. `staged` needs its own, separate, much longer staleness signal (see §7, Round 2) — reusing the 1h threshold as originally drafted would auto-abandon every legitimate staged rotation almost immediately after this ships.
- Sharing feature needs wholly new architecture: a `credential_shares` table (`org_id`, `credential_id`, `field_key` nullable, `shared_by`, `recipient_type` [`user`|`external`], `recipient_user_id` nullable, `recipient_email` nullable, `token_hash`, `created_at`, `expires_at`, `revoked_at`, `viewed_at`, `view_count`); a **new unauthenticated-but-tokenized access pattern** for external recipients (no existing precedent except FR77's public status page, which exposes no secret material — this is categorically higher risk and needs its own threat-model pass: link leakage via referrer/logs/history, replay, screenshot-after-reveal, forwarding by the legitimate recipient). Recommend: single-use or strictly time-boxed view, token never logged in full (hash only), mandatory admin notification via existing FR100 routing on every external share, and the share nudge riding on the existing rotation-schedule dashboard (FR65) rather than a new surface.

**UX (`ux-design-specification.md`):** New screens/states needed: rotation screen gains explicit "Active" vs. "Staged" credential cards with Promote/Delete-old actions and timestamps; a new Share modal/flow with recipient type toggle and expiry picker; a persistent "shared — rotate recommended" badge on the credential detail view.

**Other artifacts:** No CI/deployment/monitoring impact beyond the normal new-migration + new-route review. Audit log schema needs the two new event types added to the existing enum (`packages/shared/src/constants/audit-events.ts`).

### 2.3 Scope note on effort

Item 1 (location links) is genuinely small. Item 2 (staged rotation) is a real redesign of already-shipped Epic 5 code, but the storage model already does most of the hard part — this is a state-machine and API-surface change, not a data-model rewrite. Item 3 (sharing) is the only wholly new epic-scale piece of work, carrying real security-review weight because it introduces the product's first unauthenticated-access-to-secret-material pathway.

---

## 3. Recommended Approach

**Hybrid — Direct Adjustment for items 1–2, New Epic for item 3.** No rollback of shipped code is needed (Epic 5's rotation module is amended in place via a follow-up story, same pattern already used repeatedly in this project); no MVP/PRD goal is invalidated; no epic becomes obsolete.

| Item | Approach | Effort | Risk |
|---|---|---|---|
| 1. Location links | Direct adjustment — new story amending Epic 2 (`credential_dependencies.link_url`) | Low | Low |
| 2. Staged primary/secondary rotation | Direct adjustment — new story amending Epic 5's shipped rotation state machine; Story 13.4 rewritten to build on it | Medium–High | Medium (touches every credential's rotation path, not just multi-field) |
| 3. Temporary secret sharing | New Epic 17, sequenced after Epic 13 | High | Medium–High (new external-access security surface — recommend a dedicated security-review pass before shipping, same rigor as Epic 14's SSO work) |

---

## 4. Detailed Change Proposals

### 4.1 PRD (`prd.md`)

```
OLD (FR18, amended):
Users can initiate a rotation workflow for any stored credential and, for
multi-field secrets, select which field(s) are being rotated...

NEW (FR18, re-amended):
Users can initiate a rotation workflow for any stored credential and, for
multi-field secrets, select which field(s) are being rotated. Initiating a
rotation stages a new value alongside the current one — the current value
remains live and servable throughout. The staged value is independently
retrievable (audited separately from normal reveal) so dependent systems can
be updated to it ahead of promotion.

OLD (FR21):
The system prevents a rotation from being marked complete while systems on
the checklist remain unconfirmed.

NEW (FR21, re-amended):
The confirmation checklist is advisory, not blocking: promotion and deletion
of the old credential are explicit, independent user actions. If unconfirmed
or unverifiable-fallback checklist items remain, promoting or deleting
requires an explicit acknowledgement (reusing the existing fallback-active
acknowledgement pattern), recorded in rotation history.

OLD (FR22):
The system retires the old credential version only after all dependent
systems are confirmed and the rotation is explicitly completed.

NEW (FR22, re-amended):
The system never auto-retires the old credential version. Retirement
(cryptographic deletion of the old version's key material) is a separate,
explicit user action, only available after the new value has been promoted.
An old version may remain retrievable indefinitely after promotion until the
user explicitly retires it. A promoted-but-not-yet-retired version is
exempt from FR105's retention-count pruning (same exemption category as
today's in-progress/stale-recovery versions — see FR105 amendment below);
without this, the ordinary 3-version retention job could cryptographically
delete the very "old" version the user deliberately chose to keep alive,
out from under them, contradicting the whole point of deferring retirement.

NEW (FR105, amended): ...versions are cryptographically deleted after they
are no longer referenced by any `in_progress`/`staged` or `stale-recovery`
rotation, **and are not the "old" (pre-promotion) version of a rotation that
has been promoted but not yet explicitly retired.** The exemption lasts
until the user explicitly retires that version or its credential is
archived/deleted.

NEW FR (proposed FR122): Users can share a credential's current value, or a
specific field of a multi-field secret, for a bounded duration with either
an existing organization member or an external (non-member) recipient via a
tokenized link.

NEW FR (proposed FR123): Shared-value links are single-use or strictly
time-boxed (configurable), auto-invalidate at expiry, and can be revoked by
the sharer at any time before expiry or first view.

NEW FR (proposed FR124): Every share (creation, view, revocation, expiry) is
recorded — who shared, with whom (member or external email), when, expiry,
and outcome — and visible in the credential's history alongside rotation
history.

NEW FR (proposed FR125): After any share of a credential (or field), the
system flags that credential with a "shared — rotation recommended"
indicator, showing when and with whom, until the credential (or the shared
field) is next rotated or the flag is explicitly dismissed with a recorded
reason.

Rationale: closes the gap between "rotation confirmation is manual" (an
unchanged v1 decision) and "rotation completion is all-or-nothing" (the
part actually being replaced); adds native support for safe, non-disruptive
rotation and for tracking a real operational risk (shared secrets) that
today has no visibility in the product.
```

> **v1 Design Decision — Rotation Confirmation Model** (epics.md) is retained as-is; add one clarifying sentence: *"Manual checklist confirmation now informs, rather than gates, the promote/retire decision — see FR21/FR22 (2026-07-24 amendment)."*

### 4.2 Epics (`epics.md`)

```
Epic 5 (done) — add follow-up story:
Story 5.6: Staged Primary/Secondary Rotation State Machine (numbered 5.6,
not 5.4, since 5-4/5-5 slugs are already taken by shipped stories
"Rotation Workflow Web UI" and "Epic 5 Completion" in sprint-status.yaml)
As a user rotating a credential, I want the new value staged alongside the
still-active old value, and to promote/retire them as two separate explicit
actions, so that I never have to choose between an all-or-nothing checklist
and an unsafe in-place change.
[ACs: staged value independently retrievable + audited, gated by the same
reveal permission as normal reveal (staging never weakens who can see a
secret — it only adds a second live value to protect); promote and retire
are each their own atomic transaction (version flip + audit entry in one
commit, and cryptographic deletion + audit entry in one commit,
respectively — NFR-REL3/4 applies to both, not just the old single
completion transaction) and both are idempotent under concurrent
double-click/duplicate-request (reuses the existing advisory lock, second
concurrent attempt gets 409, per Round 3 concurrency finding); retire is
separate + only reachable post-promote; unconfirmed-checklist
acknowledgement required to promote or retire early; break-glass still
creates a staged version first, then instantly promotes and retires it in
the same transaction window — it is a zero-wait path through the same
state machine, not a bypass of version creation (Round 4 clarification);
`staged` rotations open longer than a configurable threshold (default 14
days) trigger a non-blocking `stale-staged` alert to FR100 recipients —
informational only, never auto-abandons, distinct from the existing 1h
crash-recovery `stale_recovery` mechanism (Round 2/4 finding); archiving a
credential or project with a `staged` (unpromoted) rotation is blocked or
requires explicit confirmation, extending the existing project-archival
dependency guard (v1 Scope Decision) to this new state.]

Epic 2 (done) — add follow-up story:
Story 2.10: Dependent System Location Links & Persistent Update Checkbox
As a user recording a dependent system, I want to attach an optional URL to
it and check it off as "updated" while I work through rotating a password
across every location, so that I always know which locations are done and
which aren't.
[ACs: credential_dependencies.link_url nullable text, optional, validated
as a URL when present, surfaced on the dependency list. The "updated"
checkbox is NOT new state — it reuses the existing rotation_checklist_items
confirmation (FR20) that Epic 5 already built, surfaced persistently on the
credential's dependency list (not only inside a rotation modal) for
whichever rotation is currently `staged` on that credential. The "resets
for all locations when the password is modified" behavior the user asked
for is already inherent to the existing model, not new work: each new
rotation (Story 5.6) generates a fresh, unconfirmed rotation_checklist_item
per non-archived dependency (per FR19), so every checkbox is unchecked
again the moment a new value is staged — no reset logic to write, no new
column needed. This story is purely: (a) the link field, (b) making the
existing per-dependency confirmation state visible outside the rotation
flow, on the dependency list itself.]

Epic 13 — Story 13.4 amended:
Rewrite Story 13.4's acceptance criteria to target the new staged state
machine (Story 5.6) instead of the old checklist-then-retire completion —
same field_key filtering logic (credential_dependencies.field_key,
rotations.target_fields), applied to promote/retire rather than to a single
completion transaction.

New Epic 17: Secret Sharing & Exposure Tracking
Users can temporarily share a credential's value — in full or by field —
with an org member or an external recipient via an expiring, tokenized
link, with full share history and a rotation-recommended nudge afterward.
Depends on Epic 13's field_key model for field-scoped sharing; independent
of Epic 14/15/16.
FRs covered: FR122-FR125.
Stories:
  17.1 Share a Credential with an Organization Member
  17.2 Share a Credential with an External Recipient via Secure Link
       [hardened per Round 1/3 findings: creating an external share requires
       sharer step-up re-auth (password/MFA) given the sensitivity of the
       action; the link's first GET never reveals the value — it shows a
       consent/reveal screen requiring an explicit human click, so
       automated link-unfurling (Slack/Teams/email-client preview
       crawlers, security "safe link" prefetchers) cannot silently burn a
       single-use token before the real recipient ever sees it; response
       headers set Cache-Control: no-store; org admins are notified via
       FR100 routing on BOTH creation and first view of an external share,
       not creation only; if the shared field is later renamed or removed
       (Story 13.2 semantics) the share is automatically expired rather
       than left pointing at a stale/missing field_key.]
  17.3 Share History, Expiry Enforcement & Rotation-Recommended Nudge
       [extended per Round 4 finding: promoting a rotation on a credential
       (or the specific field) automatically marks any of its outstanding
       shares as `superseded` (value changed, distinct from
       expired/revoked) and clears the "shared — rotation recommended"
       flag for that credential/field — closing the loop between Epic 17
       and Story 5.6 rather than leaving the nudge unaware that the
       recommended action already happened.]

Recommended build order: 14 -> 13 -> 17 -> 15 -> 16 (was 14 -> 13 -> 15 -> 16).
```

### 4.3 Architecture (`architecture.md`)

```
OLD (rotations.statusCheck):
sql`${t.status} IN ('in_progress','completed','abandoned','stale_recovery','break_glass_complete')`

NEW:
sql`${t.status} IN ('staged','promoted','retired','abandoned','stale_recovery','break_glass_complete')`
(migration: 'in_progress' -> 'staged', 'completed' -> 'promoted' for the
purpose of new rows; existing historical rows keep their original values —
this is an additive enum change, not a backfill, since old rows describe
completed history under the old model and must not be reinterpreted)

NEW data flow (replaces Data Flow #4):
Rotation -> human initiates -> advisory lock on credential -> new
credential_versions row written (staged), current_version_id UNCHANGED ->
checklist from credential_dependencies (advisory, not blocking) -> staged
value independently retrievable (new audited reveal path) -> per-system
confirmation (optional/advisory) -> human explicitly promotes -> ->
current_version_id flips (new AuditEvent.ROTATION_PROMOTED) -> old version
remains retrievable -> human explicitly retires -> old version
cryptographically deleted (new AuditEvent.ROTATION_OLD_RETIRED) -> SSE +
audit. Break-glass collapses promote+retire into one step, unchanged
semantics from today's break_glass_complete.

NEW table: credential_shares
(id uuid PK, org_id, credential_id FK, field_key text nullable,
shared_by user_id FK, recipient_type text CHECK IN ('user','external'),
recipient_user_id uuid FK nullable, recipient_email text nullable,
token_hash text NOT NULL, created_at, expires_at NOT NULL, revoked_at
nullable, superseded_at nullable, first_viewed_at nullable, view_count int
DEFAULT 0, status text CHECK IN ('active','viewed','revoked','expired','superseded'))
RLS: org_id-scoped like every other table. External access route is the
one exception needing a distinct auth path (token-bearer, not session/JWT)
— same category of RLS exception already precedented by `sessions`/
`refresh_tokens` (see Data Architecture's "No org_id — RLS exception"
notes), needs its own documented exception here too.

NEW AuditEvents: ROTATION_PROMOTED, ROTATION_OLD_RETIRED,
CREDENTIAL_SHARE_CREATED, CREDENTIAL_SHARE_VIEWED, CREDENTIAL_SHARE_REVOKED,
CREDENTIAL_SHARE_EXPIRED, STAGED_VALUE_REVEALED.

Rationale: the storage-level staging primitive already exists
(current_version_id flip already deferred to completion) — this reduces
what was feared to be a full data-model rewrite down to a state-machine and
API-exposure change, confirmed by direct inspection of
packages/db/src/schema/rotations.ts and architecture.md's existing
current_version_id note.
```

### 4.4 UX (`ux-design-specification.md`)

- Rotation screen: replace single "in-progress rotation" panel with two explicit cards — **Active** (current, being replaced) and **Staged** (new, pending promotion) — each with its own reveal action, plus **Promote** and **Delete old** buttons, each requiring confirmation if the checklist has unconfirmed items.
- New **Share** flow: recipient-type toggle (org member / external email), expiry picker, generated link (masked, copy-once affordance for external), and a **Shares** tab on the credential detail view listing history (who, when, expiry, viewed/revoked/expired).
- New persistent badge: **"Shared 3 days ago — rotation recommended"** on the credential detail header, linking straight to rotation initiation, dismissible with a recorded reason.
- Dependency list (credential detail view): each location row gains its optional link (clickable) and an "updated" checkbox reflecting that dependency's `rotation_checklist_item` status for the currently `staged` rotation (if any); unchecked/greyed when no rotation is staged; checking it here calls the same confirm-item action the rotation modal already uses — one state, two surfaces.

---

## 5. Implementation Handoff

**Change scope classification: Major** (item 2 amends already-shipped Epic 5 production code and its state machine; item 3 is a new epic introducing a new external-facing security surface).

| Workstream | Scope | Route to |
|---|---|---|
| Story 2.10 (location links) | Minor | Development team — direct implementation |
| Story 5.6 (staged rotation state machine) + Story 13.4 rewrite | Major | Product Manager / Solution Architect — sequencing and architecture sign-off, then development |
| Epic 17 (secret sharing) | Major | Product Manager / Solution Architect — needs a dedicated security-review pass (external-access token model) before story creation, same rigor as Epic 14's SSO work |

**Success criteria:**
- `sprint-status.yaml` updated: Epic 2 and Epic 5 reopened to `in-progress` pending their new stories (same convention as prior "completion round 2" reopenings); Epic 13's `13-4` story stays `backlog` but is flagged for AC rewrite before story creation; Epic 17 registered `backlog`.
- No existing shipped behavior regresses: `abandoned`/`stale_recovery`/`break_glass_complete` rotation paths keep their exact current meaning; only the `in_progress`→`completed` happy path is restructured.
- Epic 17 does not begin story creation until a security-review pass on the external-share token model is scheduled.

---

## 6. Approval

**Do you approve this Sprint Change Proposal for implementation? (yes / no / revise)**

---

## 7. Advanced Elicitation Findings & Amendments (2026-07-24)

Four rounds run against this proposal before implementation, targeting security risk, failure modes, and internal inconsistency. All four rounds surfaced genuine, non-cosmetic issues; every finding below was applied to the sections above (not left as open prose).

### Round 1 — Security Audit Personas (Hacker / Defender / Auditor)

- **Hacker:** a bearer-token share link is a credential with no step-up factor and no account behind it — forwarded mail, a compromised recipient inbox, or shared inbox access all silently extend who can see the secret. Link-unfurling by chat/email clients (Slack, Teams, Outlook Safe Links) fetches the URL automatically before a human ever clicks, which would burn a naive "single-use on first GET" token for nothing. **Applied:** sharer step-up re-auth on external-share creation; reveal requires an explicit second click past a consent screen, not the first GET; `Cache-Control: no-store`.
- **Hacker:** an independently-retrievable `staged` value doubles the number of currently-valid secrets in existence per credential during rotation — a bigger target, not a smaller one, if reveal permissions are any looser than normal reveal. **Applied:** explicit AC that staged reveal is gated by the identical permission check as normal reveal.
- **Auditor:** creation-only admin notification on external shares leaves no visibility into whether the link was ever actually used. **Applied:** notify on both creation and first view.

### Round 2 — Pre-mortem Analysis

- Scenario: a `staged` rotation is opened, the initiating engineer leaves the company mid-rotation, and — because retirement is now indefinitely deferred by design — the staged value sits live and largely forgotten for months, becoming exactly the kind of untracked second live secret this whole initiative exists to prevent. **Applied:** a non-blocking `stale-staged` alert (default 14 days) distinct from the existing 1h crash-recovery mechanism.
- Scenario: a credential is externally shared "for setup help," the share expires, but the "rotate recommended" nudge is dismissed once and never revisited, and the credential silently goes unrotated indefinitely. **Applied:** flagged in Epic 17 story 17.3 that dismissal must record a reason (already true) — no further mechanical fix invented here beyond what FR125 already specifies; noted as an accepted residual risk (soft nudge, not enforced) consistent with this being a v1 workflow aid, not a compliance gate.

### Round 3 — Failure Mode / Edge Case Analysis

- **Retention conflict (highest-severity finding of the whole review):** FR105's existing pruning-exemption clause only names `in_progress`/`stale-recovery` rotations. Under the new model, a promoted-but-not-yet-retired "old" version isn't covered by that exemption, so the ordinary version-retention job could cryptographically delete the old credential the user explicitly chose to keep around — silently breaking the entire "retire whenever you're ready" premise of item 2. **Applied:** FR105 and FR22 both amended with an explicit exemption for promoted-but-unretired versions (§4.1).
- Concurrent double-promote / double-retire race. **Applied:** explicit atomicity + idempotency ACs added to Story 5.6, reusing the existing advisory lock (no new concurrency primitive needed).
- Archiving a credential/project mid-`staged`-rotation, or while an external share is active, was previously unaddressed. **Applied:** extended the existing project-archival dependency guard (already in the v1 Scope Decision for active rotations) to cover `staged` rotations and active shares.
- A shared field getting renamed/removed mid-share (Story 13.2's rename semantics) would orphan the share's `field_key`. **Applied:** auto-expire the share when its field disappears (Story 17.2).

### Round 4 — Challenge from Critical Perspective

- **Inconsistency found:** the proposal claimed the "updated" checkbox's reset behavior needed no new logic because "each new rotation generates a fresh checklist" — but that claim was built on today's model, where `in_progress` rotations are short-lived by design (1h stale threshold). Under the new model, `staged` rotations are *meant* to stay open for days or weeks — reusing the 1h threshold as originally drafted would have auto-abandoned every legitimate staged rotation almost immediately after shipping, which would have silently broken item 2 on day one. **Applied:** `staged` gets its own, much longer, non-abandoning staleness signal (folded into Round 2's fix).
- **Ambiguity found:** "break-glass collapses promote+retire into one step" didn't say whether break-glass still creates a staged version at all, or bypasses versioning entirely — a real behavioral fork depending on which was meant. **Applied:** break-glass explicitly still creates a staged version, then instantly promotes and retires it in the same window — a zero-wait path through the same state machine, not a parallel bypass.
- **Gap found:** items 2 and 3 didn't reference each other at all — rotating a credential that currently has an active external share out did nothing to that share, and sharing didn't interact with the rotation-recommended nudge once the user actually rotated. **Applied:** promoting a rotation now marks outstanding shares `superseded` and clears the nudge for that credential/field (Story 17.3, `credential_shares.status`).

**Net effect:** no item was descoped or removed by this review; all four findings were incorporated as amendments to sections 2, 4.1, 4.2, and 4.3 above. The proposal is unchanged in shape (still Hybrid: direct adjustment for 1–2, new Epic 17 for 3) but is now internally consistent with the existing `rotation:recover`/FR105/archival-guard mechanisms it builds on, rather than silently contradicting them.
