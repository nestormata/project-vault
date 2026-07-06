# Story 9.5: Operational Runbook & Deployment Guide

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a platform operator managing a self-hosted deployment,
I want a complete operational runbook covering all failure and maintenance scenarios,
so that I can recover the vault reliably without tribal knowledge or guesswork during an incident.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` — this is a pure documentation deliverable (`docs/runbook.md` + a `README.md` link). No API route, no database schema, no SvelteKit page is added, modified, or removed by this story. |
| **Evaluator-visible** | no — there is no product surface to evaluate; the "user" of this deliverable is a human platform operator reading Markdown, not an end user of the web UI or API. |
| **Linked UI story** (if API-only) | N/A — not API-only; no UI is deferred by this story because none was ever in scope (this is not a feature with a missing screen, it is documentation). |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | The platform operator (the same `is_platform_operator` role introduced in Story 9.1, plus any self-hosting operator who has not yet completed vault init and therefore has no such role assigned yet) opens `docs/runbook.md` — linked from the root `README.md` under "Operations" (AC-22) — during a specific triggering event (first deploy, a scheduled upgrade, a missed backup alert, an unexpected seal, a suspected key compromise, a quarterly maintenance window) and follows a numbered, copy-pasteable procedure to a verified-successful outcome, without needing to ask a teammate or read source code. There is no web-UI journey — see Surface scope above. |

---

## Key Design Decisions & Open Questions

### D1 — Hard sequencing constraint: this story's *acceptance* is blocked on Stories 9.1–9.4 reaching `done`, even though *drafting* is not

As of this story's creation, `sprint-status.yaml` shows 9-1 through 9-4 all at `ready-for-dev` — their story files exist but **zero code has landed** (confirmed by grep: no hits for `is_platform_operator`, `requirePlatformOperator`, `platform_audit_events`, `migration-compatibility-check`, or `api-contract-tests` anywhere in `apps/`, `packages/`, or `scripts/` in this worktree). This story's own epics.md AC text opens with **"Given Epics 1–9 are complete"** and its sole acceptance mechanism (AC-25 below) is a documentation review where a non-author team member *executes* the first-time-deployment and manual-unseal procedures against a clean environment. That execution is only meaningful once the underlying endpoints, env vars, and CLI commands actually exist and behave as documented.

**Resolution:**
1. This story's prose **may be drafted immediately**, using the 9.1–9.4 story files (not epics.md's shorter summary text) as the authoritative source for exact endpoint paths, env var names, request/response shapes, and CLI commands — those story files are more detailed and, in a few places, correct stale/incorrect wording in epics.md (see D2).
2. This story's **dev-story implementation should not be marked `done`** until Stories 9.1, 9.2, 9.3, and 9.4 have all merged, because AC-25 (the documentation review) cannot be executed against real, running behavior until then. If picked up before all four have merged, complete the writing (all ACs below), mark every command/endpoint that does not yet exist with an inline `<!-- PENDING: Story 9.x -->` HTML comment (invisible in rendered Markdown, grep-able for a follow-up pass), and flag in Dev Notes which stories are still outstanding — do not silently ship documentation for a feature that does not exist without any marker.
3. Story 9.3's AC-20 already forward-references this story's exact deliverable path (`docs/runbook.md § Upgrades`) for the destructive-migration refusal error message (see `_bmad-output/implementation-artifacts/9-3-in-place-version-upgrades-and-api-parity-verification.md` lines 402-410) — this story's "Upgrades" section (AC-7 below) is not optional polish, it is a load-bearing cross-reference another story's shipped error message already points at.

### D2 — Source-of-truth precedence: shipped/story-defined names win over epics.md's literal prose where they differ

Epics.md's Story 9.5 text says *"How to identify if a migration is destructive (run `pnpm migration-compatibility-check`)"*. Story 9.3's actual Task 2 (line 66 of `9-3-in-place-version-upgrades-and-api-parity-verification.md`) defines the real root `package.json` script as `"check-migration-compatibility": "tsx scripts/migration-compatibility-check.ts"` — the invocation is `pnpm check-migration-compatibility`, not `pnpm migration-compatibility-check` (the latter is the *filename*, not the script name). **Resolution:** this story's runbook content uses `pnpm check-migration-compatibility` (the correct, shipped-story-defined command), and Dev Notes explicitly flags the epics.md wording as stale prose (same "code/shipped-story is authoritative over epics.md summary text" discipline Stories 9.2 (D2) and 9.4 (D2) already established) — this is not a new problem this story introduces, it is the same recurring drift pattern already documented twice in this epic.

### D3 — Relationship to the existing `docs/operator-quickstart.md`: no duplication, cross-link instead

`docs/operator-quickstart.md` already exists and already covers "zero to eval-ready" (first local/Docker startup, vault init/unseal ceremony via the web UI, readiness-state troubleshooting, a short "Production hardening" checklist that explicitly says *"Full runbook: Epic 9 Story 9.5 (planned)"* at line 161). This story's `docs/runbook.md` is **not** a rewrite of that document — it is the operational continuation: what to do *after* a healthy instance already exists (upgrades, backups, incident response, monitoring, quarterly maintenance) plus the two lifecycle procedures epics.md explicitly asks this story to (re-)state for a self-contained incident read (first-time deployment, manual unseal) even though they already exist in the quickstart, because an operator mid-incident should not have to jump between two files to complete one procedure.

**Resolution:**
1. `docs/runbook.md`'s "Vault Lifecycle → First-time deployment" and "→ Manual unseal" sections are written standalone (copy-pasteable without needing to also open `operator-quickstart.md`), but end with an explicit cross-reference: *"For local dev / hot-reload workflows instead of a production-style deploy, see `docs/operator-quickstart.md`."*
2. `docs/operator-quickstart.md`'s line 161 (*"Full runbook: Epic 9 Story 9.5 (planned)"*) is updated by this story to link to the real path: `[Full operational runbook](runbook.md)`.
3. No content is deleted from `operator-quickstart.md` — this story is additive.

### D4 — "No integration tests" acceptance mechanism (epics.md's literal text) is a real, different-shaped AC, not an excuse to skip verification

Epics.md's Story 9.5 text says: *"this story has no integration tests — it is a documentation deliverable; acceptance is verified by a documentation review where a team member who was not the author successfully completes the 'first-time deployment' and 'manual unseal' procedures against a clean environment without asking questions."* This is a real, specific, executable acceptance test — just not a Vitest one. **Resolution:** AC-25 below formalizes this exact review as a first-class acceptance criterion with a pass/fail bar, so it is not silently dropped as "no tests needed = nothing to verify."

### D5 — Every procedure must cite its exact source AC so the runbook can be kept in sync as 9.1–9.4 evolve during their own dev-story implementation

Because this story is drafted in parallel with (or ahead of) Stories 9.1–9.4's actual implementation (D1), and dev-story implementation frequently adjusts exact request/response shapes from what the story file specifies (error codes, field names, env var defaults), every runbook procedure below cites the exact source AC (e.g., "Story 9.1 AC-9") it is transcribing. **Resolution:** when 9.1–9.4's dev-story runs complete, a follow-up diff-check (part of each of those stories' own code-review pass, not a new task for this story) should confirm the cited procedure still matches the shipped behavior; any drift is fixed in `docs/runbook.md` at that time, not treated as this story's own bug.

### D6 — External KMS integration ('kms' `vault_state.kms_type` value) is honestly documented as **not implemented**, not aspirationally documented as available

`packages/db/src/schema/vault-state.ts` (Story 1.5, `done`)'s `kmsType` column has a check constraint allowing `'passphrase' | 'envelope' | 'file' | 'kms'`, but grep of the full `apps/api/src` and `packages/crypto/src` trees confirms `'kms'` is a **reserved enum value with no init/unseal code path that ever sets or consumes it** — only `'passphrase'` (Argon2id-derived) and `'envelope'`/`'file'` (split-key / raw-file) modes are actually implemented. The PRD's "external KMS integration (advanced option)" is a **planned, not-yet-built** capability. **Resolution:** this story's "How to configure KMS integration" procedure (AC-14) documents this accurately: it explains the three modes that exist today, how to move from `'file'` to `'envelope'` (the only implemented way to reduce key-custody risk today), and states plainly that true external-KMS (AWS KMS / GCP KMS / HashiCorp Vault) wrapping is not yet implemented in v1, with a pointer to the PRD line that scopes it as an "advanced option" for a future release. Documenting a nonexistent feature as available would be a disaster-class error per this workflow's own guardrails ("lying about completion").

### D7 — Master key rotation is a **manual, out-of-band, no-endpoint** procedure — and the runbook must disclose a real, already-identified gap

Story 9.2's D8 (`_bmad-output/implementation-artifacts/9-2-system-settings-multi-org-and-resource-monitoring.md` lines 117-121) already establishes: there is **no rotation-execution endpoint anywhere in the codebase** for the vault master key (FR101 is unrelated — it covers machine-user API key rotation, Epic 7). Story 9.2 adds a `vault_state.key_rotated_at` timestamp column purely for the age-based custody alert (FR109/AC-E9d), backfilled to `initialized_at` on migration, but **nothing in the application ever updates that column** once set. This means: **if an operator manually rotates the master key using this story's documented procedure, the age-based custody alert will keep firing anyway** — the system has no way to learn a manual rotation occurred.

**Resolution:** AC-12 below documents the manual rotation procedure ("new key file + re-encrypt sentinel", the v1 scope epics.md specifies) **and** explicitly discloses this gap in the same section, with the exact remediation available today (there is none in-app; an operator who wants the alert to reflect reality must, at minimum, know that no in-app action updates it) — flagged as an open follow-up for a future story that ships a real rotation-execution endpoint. This is not a new problem introduced by this story; it is the same gap Story 9.2 already flagged, restated here because this is the story an operator will actually read when performing the procedure.

### Open Questions (for Epic 9 sprint planning / retrospective — not blockers for this story)

1. No story in Epic 9 (or any other epic) ships a master-key rotation **execution** endpoint — `key_rotated_at` can only ever equal `initialized_at` until one exists. Candidate for a v1.1/v2 follow-up story.
2. No story ships real external-KMS wrapping (D6) — candidate for a v2 follow-up, tracked already at the PRD level as an "advanced option."
3. This story's AC-25 documentation review requires a live, clean, disposable environment (e.g., a scratch VM or fresh Docker volumes) and a second human reviewer — schedule this explicitly at Epic 9 sprint planning once 9.1–9.4 have merged; it is not something `dev-story`/`code-review` automation can perform unattended.

---

## Acceptance Criteria

### AC-1 — `docs/runbook.md` exists with the complete required section structure

**Given** Stories 9.1–9.4 have merged (D1),
**When** the operator opens `docs/runbook.md`,
**Then** the file exists at that exact path and contains, in order, top-level (`##`) sections titled exactly: **Vault Lifecycle**, **Upgrades**, **Backup & Recovery**, **Master Key Management**, **Incident Response**, **Monitoring**, and **Quarterly Operations Checklist** — matching epics.md's Story 9.5 structure verbatim so a reader searching for "Upgrades" (e.g., following Story 9.3's error-message cross-reference, D1 point 3) lands in the right place on the first try.

**Example (positive):** `grep -c '^## ' docs/runbook.md` returns exactly 7, and `grep '^## '` output matches the seven titles above in that exact order.

**Example (negative — a plausible mistake this AC prevents):** a section is titled "Backups & Recovery" (added "s") or "Recovery & Backup" (reordered) — this AC's exact-string-match requirement means Story 9.3's error message (`docs/runbook.md § Upgrades`) and this story's own README link (AC-22) must resolve to a heading that actually exists verbatim; a near-miss title is a broken cross-reference, not a cosmetic nit.

**Example (edge — sub-sections use `###`, not `##`):** e.g., "Vault Lifecycle" contains four `###` sub-procedures (first-time deployment, normal startup/shutdown, manual unseal, unexpected mid-operation seal) — the heading-level discipline (`##` for the seven required top-level sections only) is what makes AC-1's exact `grep -c '^## '` count meaningful; if sub-procedures were also `##`, the count would be wrong and this AC would need re-deriving instead of being a simple, stable check.

---

### AC-2 — Vault Lifecycle: first-time deployment procedure

**Given** a fresh checkout with no running containers and no existing Postgres volume,
**When** the operator follows the "First-time deployment" procedure,
**Then** it documents, as literal copy-pasteable commands: (1) `cp .env.example .env` and setting a production-appropriate `VAULT_BOOTSTRAP_TOKEN` (`openssl rand -base64 32`, never left blank in production, per `.env.example`'s own comment); (2) `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` (production path) or `make bootstrap-docker` (eval/dev path); (3) the vault init ceremony — `POST /api/v1/vault/init` with header `X-Vault-Bootstrap-Token: <token>` and a chosen `kmsType` (`'passphrase'` or `'envelope'`, per D6 — `'file'` is the downgraded option requiring explicit acknowledgment per Story 1.5, `'kms'` does not exist yet); (4) first unseal — `POST /api/v1/vault/unseal`; (5) first user registration via `POST /api/v1/auth/register` (the first registered user becomes the instance's platform operator, per Story 9.1's D1 bootstrap rule); (6) verification via `curl -sf http://localhost:3000/health` and `curl -sf http://localhost:3000/ready` expecting `{"status":"ready"}`.

**Example (positive):** an operator with a completely empty `docker volume ls` output follows the six steps above start-to-finish and reaches `{"status":"ready"}` with zero undocumented steps or manual source-reading.

**Example (negative — a step is silently skipped):** an operator who skips setting `VAULT_BOOTSTRAP_TOKEN` and instead sets `VAULT_ALLOW_REMOTE_INIT=true` in a **production** compose file — the runbook's procedure explicitly calls this out as **dev-only, never production** (matching `operator-quickstart.md`'s existing warning verbatim) and the first-time-deployment procedure's production path must not silently suggest it as a shortcut.

**Example (edge — vault init called twice):** re-running `POST /api/v1/vault/init` against an already-initialized vault returns an already-initialized error (per Story 1.5) — the runbook notes this is expected/safe (idempotent-to-fail, not destructive) and directs the operator to the "Manual unseal" procedure instead if they intended to unseal, not re-initialize.

---

### AC-3 — Vault Lifecycle: normal startup and shutdown sequences

**Given** an already-initialized, previously-unsealed instance,
**When** the operator performs routine start/stop (e.g., host reboot, planned maintenance window),
**Then** the runbook documents: startup is `docker compose up -d` (or the prod-override equivalent) followed by **manual unseal** — the vault does **not** auto-unseal on container start (by design, per Story 1.5 — the master key/passphrase is never persisted in a way that would allow this); shutdown is `docker compose down` (data-preserving; volumes untouched) vs. `docker compose down -v` (destroys the Postgres volume — the runbook explicitly warns this flag must never be used against a production volume without a fresh, verified backup in hand first, cross-referencing Backup & Recovery).

**Example (positive):** operator runs `docker compose down`, later runs `docker compose up -d`, then completes the unseal step (AC-4) — the instance returns to `{"status":"ready"}` with all data intact.

**Example (negative — the exact accident this AC exists to prevent):** an operator, meaning to just restart the API container, runs `docker compose down -v` instead of `docker compose down` — the runbook's shutdown section leads with a bolded warning distinguishing the two flags precisely because `-v` is destructive and the flag names differ by a single character.

**Example (edge — `stop_grace_period: 30s`):** the runbook notes the API container has a 30-second graceful-shutdown window (`architecture.md`'s Infrastructure & Deployment section) — an operator force-killing the container (`docker kill` / `SIGKILL`) instead of `docker compose down` (`SIGTERM`) risks interrupting an in-flight rotation transaction; the runbook recommends always using `docker compose down`/`stop` and never `kill -9` in normal operation.

---

### AC-4 — Vault Lifecycle: manual unseal after unexpected seal

**Given** a running instance whose vault is currently sealed (e.g., after a restart),
**When** the operator follows the "Manual unseal" procedure,
**Then** it documents: `POST /api/v1/vault/unseal` with the appropriate body for the instance's `kmsType` (passphrase string for `'passphrase'` mode; the env-half key material already present via `VAULT_ENVELOPE_KEY_HALF` plus the file-half from `VAULT_KEY_DIR` for `'envelope'` mode — the operator supplies only what is not already available to the running container); verification via `GET /ready` expecting `{"status":"ready"}` with no `warnings` array, or `curl -sf http://localhost:3000/health`.

**Example (positive):** operator in `'passphrase'` mode POSTs the correct passphrase to `/api/v1/vault/unseal`; `/ready` flips from `sealed` to `ready` within the same request/response cycle (no restart needed).

**Example (negative — wrong passphrase):** operator supplies an incorrect passphrase — the runbook documents the expected `401`/`403` response and reminds the operator this endpoint is rate-limited (per `operator-quickstart.md`'s existing readiness-states table and Story 1.5's unseal rate-limiting) so repeated guesses will eventually be throttled; it does not lock the vault permanently, but the operator should stop and verify their passphrase source (e.g., password manager) rather than retry blindly.

**Example (edge — envelope mode, missing file half):** `VAULT_KEY_DIR` (default `/run/secrets`, per `.env.example`) does not contain the expected file-half artifact (e.g., a fresh container with no volume-mounted secret) — the runbook documents this as a distinct failure mode from "wrong passphrase" (a missing-file error, not an auth rejection) and directs the operator to restore the file-half from its original secure storage location (documented at init time, per Story 1.5) rather than treating it as a lost-key scenario (see AC-13) prematurely.

---

### AC-5 — Vault Lifecycle: unexpected seal mid-operation — triage decision tree

**Given** the vault seals unexpectedly while the instance was previously in `ready` state (not a planned restart),
**When** the operator investigates,
**Then** the runbook provides a decision tree: (1) check `GET /ready` first — distinguish `sealed` (proceed to AC-4's unseal procedure) from `db` (Postgres unreachable — check `DATABASE_URL`/container health, not a vault problem at all) from `uninitialized` (should not happen on a previously-`ready` instance; if seen, treat as a possible volume/data-loss incident, not a routine reseal); (2) check container logs (`docker compose logs api` / `make docker-logs`) for the specific reseal trigger — an OOM-kill (`docker inspect --format='{{.State.OOMKilled}}'`), a crash/panic (`Vault sealed on error` type structured log lines, per `architecture.md`'s pino structured-logging convention), or a deliberate operator action (someone else on the team called an unseal-adjacent endpoint or restarted the container); (3) once cause is identified, proceed to the matching remediation — OOM: increase container memory limits before re-unsealing; crash: capture the log excerpt before restarting (it will otherwise scroll away); deliberate: confirm with the team before unsealing to avoid two people unsealing into two different intended states.

**Example (positive):** `/ready` returns `{"status":"sealed"}` with no `db`-related error — operator confirms via `docker inspect` there was no OOM-kill, checks logs for a benign restart (e.g., a deploy), and proceeds straight to AC-4's unseal procedure.

**Example (negative — treating "db" as a vault problem):** operator sees `/ready` returning `{"status":"not_ready","reason":"db"}` and attempts an unseal call anyway — the runbook explicitly calls out this as the wrong branch: an unseal call against an unreachable database will itself fail or hang; the correct first action is `make db-up` or checking `DATABASE_URL`/Postgres container health.

**Example (edge — repeated unexpected reseals, not a one-off):** the runbook flags that if seals recur within a short window (e.g., multiple OOM-kills in an hour), this is graduated to the Incident Response section's "Vault unreachable" flowchart (AC-15) rather than treated as a series of isolated one-off unseals — a repeating pattern is itself the incident.

---

### AC-6 — Upgrades: in-place version upgrade procedure

**Given** a running, healthy instance and a new image version to deploy,
**When** the operator follows the "In-place version upgrade" procedure,
**Then** it documents: (1) pull the new image (`docker compose pull` or updating the pinned tag/digest in `docker-compose.prod.yml`); (2) `docker compose up -d` — the `migrate` service (already defined in `docker-compose.yml` per Story 9.3's D1) runs pending Drizzle migrations automatically via the guarded wrapper (`db:migrate` → `tsx src/scripts/guarded-migrate.ts`, Story 9.3) before the API container begins serving requests; migration errors abort startup with a non-zero exit code and the API container does not come up in a partially-migrated state; (3) verify success via `GET /ready` returning `{"status":"ready"}` and spot-checking `GET /api/v1/openapi.json` reflects the new version's `info.version` (Story 9.3 AC-19 — read from `apps/api/package.json` at generation time, not a hardcoded placeholder).

**Example (positive):** operator upgrades from one version to the next where the only schema change is an additive `ADD COLUMN ... DEFAULT`; `docker compose up -d` completes, the `migrate` service exits 0, the API becomes healthy, and `/ready` returns `ready` with no manual intervention.

**Example (negative — migration aborts startup):** the new version bundles a migration the guarded wrapper flags as destructive (see AC-7); the `migrate` service exits 1 with the exact refusal message documented in AC-7, and the API container **never starts** (it depends on `migrate` completing successfully in `docker-compose.yml`'s service dependency graph) — the runbook states this is the correct, safe outcome: the previous version's containers, if not yet torn down, remain the last known-good state, and the operator should not force-start the API against a database mid-refusal.

**Example (edge — first `docker compose up` after a fresh image pull is slow):** per `operator-quickstart.md`'s existing "Common failures" note, the `migrate` service rebuilds the API builder image to run `pnpm db:migrate` — the runbook cross-references this known, accepted latency tradeoff (`deferred-work.md` D4) so an operator mid-upgrade does not mistake a slow-but-progressing migrate step for a hang.

---

### AC-7 — Upgrades: identifying a destructive migration and the offline migration path

**Given** an operator wants to know, ahead of an upgrade, whether the pending release contains a destructive schema change,
**When** they run `pnpm check-migration-compatibility` (D2 — the correct command; epics.md's literal text is stale) against the checked-out release,
**Then** the runbook documents: this is a static, no-database-connection scan of every committed migration file; it exits 0 if none are destructive, or lists every offending file/line if any are found. It also documents the guarded `db:migrate` wrapper's own runtime refusal (which fires automatically during AC-6's `docker compose up -d` if a destructive migration is present, whether or not the operator pre-checked), reproducing the exact refusal message Story 9.3 AC-3 specifies verbatim:

```
FATAL: migration 0036_drop_legacy_column.sql contains a destructive operation:
  DROP COLUMN "legacy_field" (line 3)
In-place auto-migration refuses destructive schema changes (AC-E9b).
Follow the documented offline migration procedure (see docs/runbook.md § Upgrades),
or re-run with --allow-destructive if you have already completed that procedure.
```

The runbook then documents the **offline migration path** itself: (1) take a fresh, verified backup (Backup & Recovery, AC-8/AC-9) before attempting anything destructive; (2) stop the API container (`docker compose stop api`) so no traffic hits the database mid-migration; (3) manually review the destructive statement's data impact (e.g., a `DROP COLUMN` — confirm the column is genuinely unused, not silently relied on); (4) if proceeding, run the migration explicitly with the escape hatch: `pnpm --filter @project-vault/db db:migrate --allow-destructive`; (5) verify data integrity post-migration (spot-check row counts, run the application's own test suite against a staging copy first if at all possible); (6) restart the API (`docker compose up -d api`) and verify `/ready`.

**Example (positive — pre-flight check clean):** `pnpm check-migration-compatibility` against a release containing only additive migrations exits 0; the operator proceeds directly to AC-6's normal upgrade procedure with no offline step needed.

**Example (negative — destructive migration attempted without `--allow-destructive`):** exactly the refusal transcript above; the operator's `docker compose up -d` leaves the API container not-started (AC-6's negative example) until they either fix the migration to be additive or complete the offline procedure and re-run with the flag.

**Example (edge — a false positive the operator should not "work around" by blindly adding `--allow-destructive`):** per Story 9.3 AC-3's own documented false-positive guards, a migration containing `ADD COLUMN "renamed_email" text` (an identifier that merely *contains* the substring "rename") is **not** flagged — if an operator sees a refusal, it is a genuine keyword match, not a naming coincidence; the runbook explicitly warns against reflexively re-running with `--allow-destructive` without reading the named file/line first, since that flag bypasses the safety check entirely rather than re-verifying it.

---

### AC-8 — Backup & Recovery: triggering a manual backup and verifying it succeeded

**Given** an operator wants an out-of-schedule backup (e.g., immediately before a risky upgrade or migration),
**When** they call `POST /api/v1/admin/backup/trigger` (platform operator only, per Story 9.1 AC-7),
**Then** the runbook documents the response shape `{ "jobId": "..." }` and how to confirm completion: poll `GET /api/v1/admin/backups` (Story 9.1 AC-8) and confirm a new entry appears with a recent `timestamp`, a non-zero `sizeBytes`, and — critically — cross-check its `checksumSHA256` (from the accompanying `.meta.json` sidecar) by running the validate endpoint (AC-10 below) rather than trusting the listing alone.

**Example (positive):**
```
POST /api/v1/admin/backup/trigger
Authorization: Bearer <platform operator token>
→ 202 { "jobId": "a1b2c3..." }
```
followed a short time later by
```
GET /api/v1/admin/backups
→ 200 [{ "filename": "backup_20260706T030000Z_org1.vault", "timestamp": "...", "sizeBytes": 48213, "keyVersion": 1, "verified": false }]
```
— `verified: false` is expected immediately after trigger; the runbook notes the operator should run AC-10's validate step before relying on this backup for a real restore.

**Example (negative — trigger call from a non-operator):** an org Owner (not platform operator) calling the same endpoint receives `403 { "code": "platform_operator_required", ... }` (mirroring Story 9.1's authorization model) — the runbook notes this endpoint is intentionally more restrictive than any org-scoped action; there is no per-org "back up my org's data only" capability in v1 (backups are whole-instance, per Story 9.1 AC-1).

**Example (edge — triggering a second backup while one is still running):** the runbook documents the expected behavior per Story 9.1's job model (pg-boss-backed) — a second trigger call while a job is in flight is accepted and queued, not rejected, but the operator should avoid unnecessary concurrent backup load on a production database during business hours; recommend checking `GET /api/v1/admin/backups` first to confirm no backup is already in progress.

---

### AC-9 — Backup & Recovery: full restore procedure, step by step

**Given** an operator needs to restore from a known-good backup (data-loss incident, failed upgrade, disaster recovery drill),
**When** they follow the restore procedure,
**Then** the runbook documents, in order: (1) **seal is not required as a manual pre-step** — the restore endpoint itself handles this, but the operator should stop the API container first to avoid confusing in-flight requests with the restore transaction; (2) call `POST /api/v1/admin/backups/:filename/restore` with the explicit confirmation body `{ "confirmRestore": true, "reason": "<why>" }` (Story 9.1 AC-9 — the reason is mandatory and free-text, intended for the operator's own incident record, not silently optional); (3) the runbook states plainly, in bold, that **this is destructive — all current data is replaced** with the backup's contents, with no partial/selective restore option in v1; (4) after restore completes, the vault is **automatically sealed** (Story 9.1 AC-9) and requires a manual unseal (AC-4 above) before the instance is usable again; (5) post-restore verification: unseal, then `GET /ready` returns `ready`, then spot-check a known credential/project exists as expected in the restored data.

**Example (positive):**
```
POST /api/v1/admin/backups/backup_20260705T030000Z_org1.vault/restore
{ "confirmRestore": true, "reason": "recovering from accidental credential deletion, 2026-07-06 incident #42" }
→ 202 { "jobId": "..." }
```
followed by the vault reporting `sealed`, then a successful manual unseal (AC-4), then `/ready` returning `ready` with the pre-incident data present.

**Example (negative — missing confirmation):** `POST .../restore` with `{ }` (no `confirmRestore`) — the runbook documents the expected `400`/`422` validation rejection (Story 9.1's explicit-confirmation-step requirement) and notes this is a deliberate safety gate, not a bug to route around by guessing the right body shape from documentation alone; always use the exact shape shown above.

**Example (edge — restoring a backup from a materially older `vaultVersion`):** the backup's `.meta.json` sidecar records `vaultVersion` (Story 9.1 AC-2) — the runbook notes an operator restoring a backup taken before a since-applied destructive migration (AC-7) needs to be aware the restored schema will not match the currently-deployed application version; recommend restoring to a matching application version first (roll back the image), or treat this as requiring the same offline-migration care as AC-7, not a routine restore.

---

### AC-10 — Backup & Recovery: quarterly backup restore validation procedure

**Given** the Quarterly Operations Checklist (AC-23) requires a periodic restore-validation exercise,
**When** the operator runs `POST /api/v1/admin/backups/:filename/validate` (Story 9.1 AC-10) against the most recent backup,
**Then** the runbook documents: this decrypts and verifies structural integrity in an **isolated, read-only context — no live data is modified**, returning `{ "valid": bool, "assetsPresent": { "credentials": true, "projects": true, "users": true, "auditEvents": true }, "checksum": "match"|"mismatch" }`; the runbook instructs the operator to treat any `false` value in `assetsPresent` or a `"mismatch"` checksum as a **failed** quarterly validation requiring immediate escalation (do not wait for the next quarter — the backup chain may be silently broken), and to record the pass/fail result in the org's own change-management log (outside this application).

**Example (positive):**
```
POST /api/v1/admin/backups/backup_20260706T030000Z_org1.vault/validate
→ 200 { "valid": true, "assetsPresent": { "credentials": true, "projects": true, "users": true, "auditEvents": true }, "checksum": "match" }
```
— quarterly check passes; recorded and closed.

**Example (negative — corrupted backup file):**
```
POST /api/v1/admin/backups/backup_corrupted.vault/validate
→ 200 { "valid": false, "assetsPresent": { ... }, "checksum": "mismatch" }
```
— the runbook instructs: do not attempt a real restore from this file; immediately trigger a fresh manual backup (AC-8), validate the new one, and investigate the storage destination (disk corruption, S3 object corruption, or an interrupted write) for the root cause of the older file's failure.

**Example (edge — validation run against a backup mid-upload to S3):** if `BACKUP_S3_BUCKET` is configured and the operator validates a backup whose upload has not yet fully propagated (eventual consistency), the runbook recommends waiting for the backup's listing entry (AC-8) to show a stable `sizeBytes` across two successive `GET /api/v1/admin/backups` polls before validating, to avoid a false "mismatch" caused by validating a partially-written object rather than the backup itself being bad.

---

### AC-11 — Backup & Recovery: what to do when a backup has been missed for more than 24 hours

**Given** a `backup.missed` alert has fired (Story 9.1 AC — `BACKUP_MAX_AGE_HOURS`, default 25),
**When** the operator investigates,
**Then** the runbook documents a triage sequence: (1) check the pg-boss job logs / structured operational logs for the scheduled `BACKUP_SCHEDULE` job (default: daily at 03:00 UTC) — look for a `backup.failed` alert or job-error log entry around the missed window; (2) if the job failed with a storage error (e.g., `BACKUP_S3_BUCKET` unreachable, disk full at `BACKUP_STORAGE_PATH`), remediate the storage destination first; (3) trigger a manual backup immediately (AC-8) to close the gap rather than waiting for the next scheduled run; (4) confirm `GET /api/v1/admin/backups` shows the new, successful entry and re-check `GET /ready` no longer reports any backup-related warning.

**Example (positive):** operator finds a `backup.failed` alert citing `ENOSPC` (disk full) at `BACKUP_STORAGE_PATH`, frees disk space, triggers a manual backup, confirms success, and the `backup.missed` condition clears on the next scheduled health check.

**Example (negative — treating the alert as a false alarm without investigating):** the runbook explicitly warns against silencing/acknowledging the alert without confirming a fresh, valid backup exists — `BACKUP_MAX_AGE_HOURS` (default 25) already has slack built in for timing drift (Story 9.1), so a firing alert reliably means the RPO (24h, per PRD's Reliability NFR) is currently at risk, not a false positive.

**Example (edge — backup intentionally disabled):** Story 9.1 AC-15 allows backups to be entirely disabled for operators using external backup tooling — the runbook notes that in this configuration, `backup.missed` alerts should never fire in the first place; if one does fire on an instance where backup was believed disabled, that is itself a configuration-drift incident (verify the disable setting actually took effect) rather than a normal missed-backup scenario.

---

### AC-12 — Master Key Management: how to rotate the master key (manual procedure, v1 scope) and its disclosed limitation (D7)

**Given** an operator needs to rotate the master key (scheduled hygiene, or a suspected-compromise precaution),
**When** they follow the documented procedure,
**Then** the runbook states the v1 scope precisely: (1) generate a new key file (mode-dependent: a new passphrase for `'passphrase'` mode, or new env/file halves for `'envelope'` mode); (2) re-encrypt the sentinel value (`vault_state.encrypted_sentinel`) and bump `vault_state.keyVersion`, per the same mechanism Story 1.5 uses at init time, run as an offline maintenance operation with the API stopped; (3) re-seal and re-unseal with the new key material to confirm it decrypts correctly before considering the rotation complete; (4) take a fresh backup immediately after rotation (the backup encryption key is itself HKDF-derived from the master key, per Story 9.1 D5 — a backup taken with the *old* key is still restorable using key-version-aware decryption, but a fresh post-rotation backup is good hygiene).

Immediately following this procedure, the runbook **explicitly discloses** (D7): *"Rotating the master key via this manual procedure does **not** update `vault_state.key_rotated_at` — there is no application code path that does so as of Epic 9. The FR109 age-based key-custody alert (default: fires after 365 days since `key_rotated_at`, which is backfilled to `initialized_at`) will continue to use the original init timestamp regardless of any manual rotation you perform, and **will fire again on schedule** even immediately after a real rotation. This is a known, disclosed limitation — track it, do not assume the alert reflects your actual rotation history."*

**Example (positive):** operator in `'passphrase'` mode generates a new 20+ character passphrase, performs the offline re-encrypt-sentinel/re-seal/re-unseal cycle, confirms `/ready` returns healthy with the new passphrase, and takes a fresh backup — rotation is functionally complete.

**Example (negative — operator assumes the custody alert will clear after manual rotation):** six months later the FR109 alert fires again despite the manual rotation three months prior — this is **expected, not a bug**, per the disclosed limitation above; the runbook pre-empts a support/confusion incident by stating this plainly rather than letting the operator discover it by filing a false-bug report.

**Example (edge — rotation attempted in `'file'` mode):** the runbook notes `'file'` mode (the "downgraded" option per Story 1.5, requiring explicit acknowledgment at init) has the weakest rotation story — the raw key file must be replaced and the sentinel re-encrypted with no split-key defense-in-depth; the runbook recommends operators on `'file'` mode migrate to `'envelope'` mode (a full re-init with data migration, since there is no in-place mode-conversion endpoint) rather than repeatedly rotating within `'file'` mode.

---

### AC-13 — Master Key Management: what to do if the key file is lost (unrecoverable) — and how to prevent it

**Given** an operator has lost the key material required to unseal (e.g., `VAULT_KEY_DIR`'s file-half deleted with no backup, or a `'passphrase'`-mode passphrase forgotten with no password-manager record),
**When** they consult this section,
**Then** the runbook states plainly, without hedging: **the data is unrecoverable.** There is no master-key-recovery mechanism, backdoor, or support escalation path that can decrypt existing data without the original key material — this is a deliberate architectural property (AES-256-GCM with a master-key-derived key hierarchy; losing the master key is equivalent to losing every secret, credential, and audit-log signing key it protects). The only "recovery" is restoring from a backup **encrypted under a still-available key** (i.e., this scenario is only survivable if a previous, still-decryptable backup exists — which itself requires the *backup's* key material, HKDF-derived from the *same* now-lost master key, meaning a truly lost master key also makes all its own backups permanently unreadable). The runbook then pivots to **prevention**: use `'envelope'` mode (split env-half/file-half, so a single lost artifact is not immediately fatal — the other half plus a recovery process for the missing half is possible if the two halves are stored with genuinely independent custody, e.g., an env var in a secrets manager plus a file in a separate secure location), never `'file'` mode for production, and maintain the key material under the same operational discipline as the backups themselves (independent, tested, access-controlled storage).

**Example (positive — prevention, not recovery):** an operator sets up `'envelope'` mode at init time with the file-half stored in a separate, access-controlled secrets vault (not the same host) and the env-half injected via their orchestration platform's secret-management feature — a single lost artifact (e.g., the host disk failing) does not make data permanently unrecoverable, because the independently-stored half survives.

**Example (negative — the exact unrecoverable scenario):** `'file'` mode, single key file, stored only on the same host's local disk with no off-host copy; the disk fails. The runbook states this is total, permanent data loss with no recovery path — not a worst-case hypothetical, a direct consequence of the architecture's own security model (the same property that makes a host compromise not automatically expose the master key without also having the file also protects against any vendor/application-level bypass).

**Example (edge — a "recovery" request that must be refused as unsafe rather than attempted):** the runbook explicitly instructs that if an operator asks whether raw database access (e.g., `psql` as the `postgres` superuser) can recover data without the key, the answer is no — the ciphertext in `secrets`/`secret_versions` etc. is opaque without the key; there is no partial-recovery or brute-force-feasible path (256-bit key space), and attempting to "guess" is not a real remediation path worth the operator's time.

---

### AC-14 — Master Key Management: KMS integration status and configuration (honest documentation, D6)

**Given** an operator wants to reduce key-custody risk beyond `'passphrase'`/`'envelope'` modes,
**When** they consult the "KMS integration" section,
**Then** the runbook states accurately: **true external KMS integration (AWS KMS, GCP KMS, HashiCorp Vault, etc.) is not implemented in v1** — `vault_state.kms_type`'s `'kms'` enum value is reserved in the database schema for a future release but has no corresponding application code path today (D6). The runbook documents what **is** available today as the closest mitigation: `'envelope'` mode's split-key design (env-half + file-half, each independently custodied), and cross-references the PRD's own framing of external KMS as a "v2 advanced option" so the operator is not left thinking this is an oversight rather than a scoped, disclosed v1 boundary.

**Example (positive — correct operator expectation-setting):** an operator reading this section before deployment chooses `'envelope'` mode for production specifically because they now understand `'kms'` mode does not exist yet, rather than configuring `kmsType: 'kms'` (which the init endpoint will reject, since no code path accepts it) and being surprised by a runtime error.

**Example (negative — the disaster this AC prevents):** documentation that vaguely implies "KMS integration available as an advanced option" without stating it is unimplemented would lead an operator to attempt configuring AWS KMS credentials that are silently never consulted — a genuine "lying about completion"-class documentation defect this AC exists specifically to prevent (per this workflow's own guardrails).

**Example (edge — a future release ships real KMS support):** the runbook's KMS section includes a dated note (e.g., "as of Epic 9 / v1") so a future reader knows this section may be stale once a real KMS story ships, rather than assuming permanent unavailability; when that story lands, updating this section is that story's own documentation responsibility, not silently left for someone to notice independently.

---

### AC-15 — Incident Response: "vault unreachable" triage flowchart

**Given** the instance is completely unreachable (health checks failing, no HTTP response at all — a strictly worse condition than AC-5's "sealed but responsive"),
**When** the operator triages,
**Then** the runbook provides a flowchart distinguishing: (1) **container not running at all** — `docker compose ps` shows the API container exited/restarting; check `docker compose logs api` for a crash-loop, most commonly a failed env-var validation at startup (Zod schema failure, per `operator-quickstart.md`'s existing `FATAL: missing required environment variables` troubleshooting entry) or an unrecovered OOM-kill loop; (2) **container running but not responding** — check `docker compose logs api` for a hang (e.g., a stuck migration, per AC-6); check Postgres reachability independently (`docker compose logs db`, `pg_isready` equivalent); (3) **container responding but `/health`/`/ready` both timing out** — check for a database connection-pool exhaustion (cross-reference the `db_pool_connections_active` Prometheus gauge, Monitoring section AC-19) or an event-loop-blocking bug (check CPU usage — Node.js is single-threaded for non-worker-thread code, per `architecture.md`'s crypto worker_threads design). Each branch ends in a concrete remediation: restart the specific failed component, roll back to the last-known-good image if the failure correlates with a just-completed upgrade (AC-6), or escalate to the Backup & Recovery restore procedure (AC-9) only if data corruption (not just unavailability) is suspected.

**Example (positive):** operator finds `docker compose ps` shows the API container in a restart loop, `docker compose logs api` shows the Zod env-validation `FATAL` error naming a missing var, sets the var, restarts — resolved without any data-layer involvement.

**Example (negative — jumping straight to restore without confirming it's needed):** an operator who sees the instance unreachable and immediately reaches for the restore procedure (AC-9) without first checking whether this is a simple container-crash-loop (AC-15 branch 1) — the runbook explicitly sequences the flowchart to rule out non-destructive causes first, since a restore is itself a destructive, hours-long operation that should not be reached for reflexively.

**Example (edge — the failure correlates exactly with a recent deploy):** the runbook recommends, as a fast first branch regardless of the specific symptom, checking whether the unreachability began immediately after the most recent `docker compose up -d` (upgrade) — if so, rolling back to the previous image tag is very often faster and safer than deep triage, provided no destructive migration (AC-7) was part of the failed upgrade (which would make rollback unsafe without the offline procedure).

---

### AC-16 — Incident Response: audit log storage at 95% capacity — export-and-prune procedure

**Given** a `key_custody_risk`-style tiered alert has fired for audit storage at the 95% `AUDIT_LOG_STORAGE_LIMIT_GB` threshold (Story 9.2 AC — default 50GB, configurable) and the documented maintenance mode has activated (audit writes suspended, replaced with `WARN`-level structured log entries),
**When** the operator responds,
**Then** the runbook documents: (1) confirm the condition via `GET /ready` — expect `{"status":"ready","warnings":["audit_storage_critical"]}`; (2) identify the responsible org(s) via the alert payload's `topContributingOrgs` breakdown (Story 9.2 D10 — `{ orgId, bytesAdded, rowsAdded }`, top 5 by growth) rather than guessing; (3) export the audit log for compliance retention before pruning anything (Story 8.2's export mechanism — never prune without a completed, verified export first, since `audit_log_entries` is the org's compliance record); (4) prune entries older than the org's configured retention period (FR70 — Organization Admins can configure retention within tier limits) via the existing retention-purge mechanism; (5) re-check `pg_total_relation_size('audit_log_entries')` drops below the 80% tier before considering the incident resolved and confirming `/ready` no longer reports the warning; (6) note that **security-critical event types were never suspended** even during maintenance mode (Story 9.2 D10's allowlist) — the export step is not recovering "missing" security events, only routine/credential-reveal-class events that were legitimately queued as `WARN` log lines during the suspension window (which should also be reviewed, not just discarded, since they are the operational record of what happened during the suspension).

**Example (positive):** operator identifies one org responsible for 90% of recent growth (a scripted integration generating excessive credential-reveal events), exports and prunes that org's aged-out entries per its retention policy, storage drops to 78% utilization, `/ready` clears the warning.

**Example (negative — pruning before exporting):** the runbook explicitly warns against running any prune/delete step before the export completes and is verified readable — audit log entries are the org's compliance evidence; an unverified export followed by a prune could result in permanent, undetected data loss disguised as routine maintenance.

**Example (edge — the responsible org disputes the growth is illegitimate):** the runbook notes this is a business/product conversation (e.g., a legitimately high-activity org near its tier limit should be guided toward upgrading their tier's audit-log-entries limit, FR70) — not something resolved by silently deleting their data faster; the technical remediation (export-and-prune) buys time, it does not replace addressing root cause (tier limit vs. actual usage).

---

### AC-17 — Incident Response: break-glass rotation post-incident sweep checklist

**Given** a break-glass emergency rotation was performed during an incident (`POST .../rotations/break-glass`, Story 5.3),
**When** the operator performs the post-incident sweep,
**Then** the runbook documents a checklist: (1) confirm the break-glass rotation's overlap window (if any) has fully expired and the old credential value is confirmed revoked/rotated in the actual target system, not just marked rotated in Project Vault; (2) verify the break-glass action produced the expected audit trail entries (per Story 5.3's audit-on-break-glass requirement) and that they are visible via the standard org-scoped audit search (Story 8.2); (3) confirm the rotation web UI's hardening fixes are functioning as expected for this specific incident — specifically that the new-value entry field was cleared client-side on submit/teardown per Story 8.5's hardening finding (no lingering plaintext secret in browser memory/devtools after the emergency action); (4) review whether the incident that triggered the break-glass action requires a broader credential sweep (e.g., if one credential was compromised, were any dependent credentials — Story 2.4's dependency tracking — also potentially exposed and requiring their own rotation); (5) document the incident timeline and root cause in the org's own incident record (outside this application).

**Example (positive):** operator confirms the emergency-rotated database password is fully propagated (old password rejected by the target database), audit entries for the break-glass action are searchable in the org's audit log, no dependent credentials were flagged as also-exposed, and the incident is closed with a written summary.

**Example (negative — sweep skipped, incident closed prematurely):** the runbook warns against closing an incident immediately after the break-glass rotation itself succeeds — the *rotation* succeeding is necessary but not sufficient; skipping the dependency-sweep step (item 4) risks leaving a genuinely compromised dependent credential unaddressed because it was never rotated, only the originally-flagged one was.

**Example (edge — break-glass used for a credential with no configured dependents):** the sweep checklist's dependency-review step (item 4) still applies — the runbook notes "no dependents configured" is a valid, fast answer to check, but the operator should confirm this reflects reality (dependents were actually recorded in Project Vault via Story 2.4) rather than an unconfigured gap masquerading as "nothing to worry about."

---

### AC-18 — Incident Response: compromised machine user API key — emergency revoke procedure

**Given** a machine user's API key is suspected compromised (leaked in a log, committed to a public repo, etc.),
**When** the operator responds,
**Then** the runbook documents the immediate action: `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke` (Story 7.2) — no request body — which sets `revokedAt` **immediately, with no overlap window** (deliberately distinct from the routine `.../rotate` endpoint's overlap-based zero-downtime rotation, since a suspected compromise means the old key must stop working *now*, not after a grace period); the runbook notes this call requires MFA (an org admin's MFA-verified session) and is itself rate-limited (per Story 7.2's stolen-key-callable-repeatedly guard) — the operator should not need multiple attempts, but should not interpret a rate-limit response as the revoke having failed silently. Post-revoke, the runbook directs the operator to: (1) confirm via the machine user's key list that the key now shows `revokedAt` populated; (2) issue a replacement key for the machine user's legitimate automated workflows (a fresh key, not a rotation of the revoked one — the revoked key cannot be "rotated" further, per Story 7.2's `api_key_already_revoked` rejection semantics); (3) update the CI/CD or automation system's stored credential with the new key; (4) review the audit trail for any usage of the compromised key between suspected exposure and revocation, to scope the incident.

**Example (positive):**
```
POST /api/v1/machine-users/mu_abc123/api-keys/pk_9f3aB7xQ.../emergency-revoke
Authorization: Bearer <org admin token, MFA verified>
→ 200 { "revokedAt": "2026-07-06T14:22:01.000Z" }
```
followed by issuing a fresh key and updating the CI system's secret store — the compromised key is unusable within seconds of the call, with no overlap window during which it remains valid.

**Example (negative — attempting to "rotate" an already-revoked key instead):** operator mistakenly calls `.../rotate` on the now-revoked key expecting it to generate a replacement — the runbook documents the expected `409`-class `{"code": "api_key_already_revoked"}` rejection (Story 7.2) and directs the operator to the machine user's **create-new-key** flow instead, not the rotate flow, since rotation is defined only for still-active keys.

**Example (edge — the revoke call itself is attempted without MFA):** an org admin whose session has not completed MFA (or is past its grace period) attempts the emergency-revoke — the runbook documents the expected `403 mfa_required` rejection and notes this is intentional: a stolen *session* alone (without a second factor) must not be sufficient to reason about — or interfere with — key-compromise incident response, matching the codebase's broader MFA-required-for-privileged-actions pattern.

---

### AC-19 — Monitoring: scraping Prometheus metrics and what each metric means

**Given** an operator wants to wire up external monitoring,
**When** they consult the Monitoring section,
**Then** the runbook documents: `GET /metrics` is bound to `localhost`-only by default (per `architecture.md`'s Maintainability NFR and the actual route implementation's `metricsBindHost` check) — external scraping requires explicitly configuring the bind host, and the runbook shows how; it also documents the currently-shipped metric set, verified against the actual code (not aspirational): `http_requests_total` / `http_request_duration_seconds` (per-route request volume/latency, labeled `method`/`route`/`status_code`), `process_uptime_seconds`, `vault_sealed` (1 = sealed/uninitialized, 0 = unsealed — the single most important dashboard tile for this application), `db_pool_connections_active` (in-flight query count — a sustained high value indicates the connection-pool-exhaustion failure mode referenced in AC-15), plus the Story 5.x rotation-lifecycle metrics (`rotation_initiations_total`, `rotation_completions_total`, `rotation_checklist_items_pending_total`, `rotation_break_glass_total`, and related stale/recovery counters/gauges) plus Node.js's own default process metrics (`collectDefaultMetrics()`).

**Example (positive):** an operator configures Prometheus to scrape `http://localhost:3000/metrics` from a sidecar/same-host collector (satisfying the loopback-only default without needing to change the bind host), and builds a dashboard panel alerting on `vault_sealed == 1` for more than 2 minutes (an unattended reseal, worth paging on) plus `db_pool_connections_active` sustained above a threshold.

**Example (negative — attempting external scrape without reconfiguring the bind):** an operator points an external Prometheus server directly at the container's exposed port expecting `/metrics` to respond — the runbook documents the expected `403 {"error": "Forbidden"}` response for any non-loopback caller when `metricsBindHost` is not explicitly set to `0.0.0.0`, and that this is a deliberate default-secure posture, not a bug — the runbook shows the exact configuration change required to opt in to external scraping intentionally.

**Example (edge — a metric name an operator might expect but that does not exist):** the architecture doc's prose (`architecture.md` line 460) mentions "pg-boss queue depth" as a planned custom metric, but grep of the actual codebase confirms **no such metric is implemented** as of Epic 9 — the runbook lists only metrics verified to exist in code, and does not reproduce architecture.md's aspirational list uncritically; this gap is noted as a documentation-drift item (architecture.md is ahead of implementation here) rather than silently promising a metric an operator will search for and not find.

---

### AC-20 — Monitoring: key alert types and their recommended response actions

**Given** the various alert types this application can raise (`admin_alerts` rows, notification-routed alerts, and `/ready` warnings),
**When** the operator consults this section,
**Then** the runbook provides a table mapping each known alert type to its recommended first response, cross-referencing the relevant procedure elsewhere in the runbook: `backup.missed` / `backup.failed` → AC-11; `key_custody_risk` (file-KMS-with-backup-enabled, or key age > `KEY_ROTATION_MAX_AGE_DAYS`) → AC-12/AC-13/AC-14; `resource.orgs_near_limit` and other tier-threshold alerts (80/90/95%) → contact the org to plan a tier upgrade or usage reduction, not a technical incident; `audit_storage_critical` (95% audit storage) → AC-16; the existing, already-shipped alert types from earlier epics (e.g., failed-authentication-threshold alerts, FR73; dormant-user alerts, FR71) → their existing, already-documented response owners (Organization Admins, not the platform operator) are noted explicitly so the operator does not mistake an org-level alert for a platform-level one requiring their action.

**Example (positive):** operator sees a `key_custody_risk` alert, consults this table, is routed to AC-12/AC-14, and follows the correct procedure rather than guessing.

**Example (negative — misrouting an org-level alert to platform-operator action):** a dormant-user alert (FR71, routed to org Owners/Admins per Story 8.3) lands in a shared ops channel the platform operator also monitors — the runbook's table explicitly flags this alert type as "org-level; no platform-operator action required" so the operator does not spend incident-response time on an alert that is not theirs to act on.

**Example (edge — an alert type not yet listed in this table):** the runbook notes this table should be treated as living documentation — any new alert type introduced by a future story should be added here as part of that story's own Dev Notes / documentation-impact review, the same discipline already established by this story's own D5 (keep runbook procedures in sync with the stories that define their underlying behavior).

---

### AC-21 — Monitoring: how to verify audit log integrity — and the PJ9 cross-log distinction

**Given** an operator wants to verify the audit log has not been tampered with,
**When** they consult this section,
**Then** the runbook documents **both** verification endpoints, distinctly: `GET /api/v1/org/audit/verify` (Story 8.1 — the per-org security audit log, `audit_log_entries`, requires Owner or explicit Audit role) and `GET /api/v1/platform/audit/verify` (Story 9.4 — the separate, immutable platform operator audit log, `platform_audit_events`, platform-operator-only, response includes the `X-Log-Scope: platform` header). The runbook explicitly states the PJ9 boundary from epics.md's Epic 9 preamble: these are **two entirely separate logs with no unified cross-log search in v1** — an operator investigating a full incident picture must know to check both independently; this boundary is a deliberate v1 scope decision, not an oversight, and is called out here precisely so an operator does not assume checking one log means they have checked "the" audit trail.

**Example (positive):** operator runs both `GET /api/v1/org/audit/verify?from=...&to=...` (as an org Owner) and `GET /api/v1/platform/audit/verify?from=...&to=...` (as the platform operator) as part of the quarterly checklist (AC-23), gets `{"valid": true, ...}`-equivalent results from both, and records both checks as complete — not just one.

**Example (negative — checking only one log and assuming full coverage):** an operator investigating a suspected data-tampering incident checks only `GET /api/v1/org/audit/verify` (finding it clean) and concludes there was no tampering — the runbook warns this is an incomplete investigation if the suspected action was a *platform-operator* action (e.g., an admin-initiated org creation or a backup/restore), which is recorded exclusively in the platform log, not the org log.

**Example (edge — the vault is sealed when verification is attempted):** both verify endpoints require an unsealed vault (they need the respective signing key to recompute HMACs) — the runbook documents the expected `503` response in that state and directs the operator to complete AC-4's unseal procedure first.

---

### AC-22 — `docs/runbook.md` is linked from the root `README.md` under "Operations"

**Given** the root `README.md`,
**When** a reader looks for operational documentation,
**Then** `README.md` contains a top-level `## Operations` section (a new section — none exists today, confirmed by grep) linking to `docs/runbook.md`, positioned logically near the existing "Production Usage" / "Base Image Update Procedure" content (currently under the README's Development-oriented sections), and `docs/operator-quickstart.md`'s own stale forward-reference (line 161, *"Full runbook: Epic 9 Story 9.5 (planned)"*) is updated to a real link per D3.

**Example (positive):** `grep -n '## Operations' README.md` returns a match, and the section's body contains a working relative link `[docs/runbook.md](docs/runbook.md)` (or equivalent), verified by confirming the target file exists at that exact relative path from the README's location (repo root).

**Example (negative — a dangling link):** the README references `docs/runbook.md` before this story's own AC-1 has actually created that file at that exact path — this AC and AC-1 must land together in the same story (they do, since both are this story's deliverables), so no intermediate state ships with a broken link; if this story is implemented incrementally, the README link is the *last* task committed, after the file exists.

**Example (edge — `operator-quickstart.md`'s existing content that already partially duplicates runbook material):** the "Production hardening (before non-dev deploy)" section in `operator-quickstart.md` (its 5-item checklist) is left in place unmodified except for its final bullet's link update (D3) — this story does not need to delete or merge that checklist into `runbook.md`; the two documents serve different moments (pre-first-deploy hardening vs. ongoing operations) and cross-link rather than consolidate.

---

### AC-23 — Quarterly Operations Checklist section

**Given** the runbook's final required section,
**When** the operator consults "Quarterly Operations Checklist",
**Then** it lists, as a literal checklist (Markdown task-list syntax), exactly the six items epics.md specifies: backup restore validation (→ AC-10), audit log integrity check (→ AC-21, both logs), dormant user review (→ FR71/Story 8.3's existing dormant-user alert mechanism — the runbook notes this is normally an org-admin responsibility but the platform operator should confirm the alert mechanism itself is healthy instance-wide), key custody review (→ AC-12/AC-13/AC-14 — confirm `kmsType` is not `'file'` in production, confirm awareness of the `key_rotated_at` limitation), CVE scan review (→ the existing Trivy CI gate and `.trivyignore` mechanism — review any currently-active `.trivyignore` entries for continued justification, not just automatic CI-driven expiry), and `.trivyignore` expiry audit (→ confirm no entry is approaching its `exp: YYYY-MM-DD` deadline without a renewal plan, cross-referencing the existing CI-enforced 30-day-max window from `.github/workflows/ci.yml`).

**Example (positive):** an operator running this checklist quarterly checks all six boxes, records the pass/fail outcome of each (especially AC-10 and AC-21, which have real pass/fail semantics, not just "was performed"), and files any failures as incidents per their respective runbook sections.

**Example (negative — a checklist item marked complete without actually verifying its underlying condition):** an operator checks off "backup restore validation" without actually calling `POST .../validate` (AC-10) — the runbook frames each checklist item as a link to a concrete, verifiable procedure specifically to prevent this "checked the box without doing the thing" failure mode; the checklist is not free-standing prose, each item is a pointer to an executable AC.

**Example (edge — an org too new to have any dormant users yet):** the runbook notes "dormant user review" quarterly item is still worth confirming even on a brand-new instance — the *mechanism's* health (is the FR71 alert wired up and would it fire if a dormant user existed) is the thing being reviewed, not merely "were there any dormant users this quarter" (a vacuously-true "no dormant users" is not the same as "the alert mechanism is confirmed working").

---

### AC-24 — Cross-references are exact and are verified against the actual shipped stories, not epics.md's summary alone

**Given** this story cites specific endpoints, env vars, error codes, and table names throughout (AC-2 through AC-23),
**When** a reviewer checks the runbook against the actual 9.1–9.4 dev-story implementations after they merge (D1, D5),
**Then** every cited endpoint path, env var name, and response shape in `docs/runbook.md` matches what those stories actually shipped — not what their story files specified before implementation, if the two have since diverged. Any divergence discovered is fixed in `docs/runbook.md` directly (a documentation update, not a new story) as part of closing out this story or as a fast-follow noted in Dev Notes.

**Example (positive):** post-merge, a reviewer spot-checks `POST /api/v1/admin/backup/trigger`'s actual response shape against what AC-8 documents and confirms an exact match — no update needed.

**Example (negative — a shipped story renamed something after dev-story implementation):** if Story 9.3's dev-story run ultimately renames `check-migration-compatibility` to something else during implementation (a hypothetical but realistic risk, since even this story's own D2 already found one such rename relative to epics.md), this AC requires `docs/runbook.md` to be updated to match the final shipped name before this story is considered complete — an operator running a stale, renamed command from the runbook is exactly the "tribal knowledge gap" this whole story exists to eliminate.

**Example (edge — a cited AC number shifts during another story's adversarial-review pass):** Stories 9.1–9.4 have all undergone (or will undergo) an adversarial-review pass that can renumber or split ACs (as already visible in this codebase's `*-adversarial-review.md` files for other stories) — this story's cross-references cite AC content/behavior primarily, with AC numbers as a secondary locator; a renumbering alone (with unchanged behavior) does not require a runbook rewrite, only a reference-number touch-up.

---

### AC-25 — Acceptance mechanism: documentation review by a non-author (no integration tests, per epics.md's literal text and D4)

**Given** `docs/runbook.md` is complete and Stories 9.1–9.4 have merged (D1),
**When** a team member who did **not** author this story's documentation attempts, against a genuinely clean environment (fresh checkout, no pre-existing Docker volumes, no prior vault state), the "First-time deployment" (AC-2) and "Manual unseal after unexpected seal" (AC-4) procedures using **only** `docs/runbook.md`'s text,
**Then** they reach a `{"status":"ready"}` instance for AC-2 and successfully transition a deliberately-sealed instance back to `{"status":"ready"}` for AC-4, in both cases without asking the author a clarifying question and without reading any source code beyond what the runbook itself instructs them to run.

**Example (positive — the actual pass bar):** the reviewer completes both procedures start-to-finish, reports zero ambiguous steps, and the story is marked `done` on this basis (no Vitest/integration test suite is required or expected for this story, per epics.md's explicit text).

**Example (negative — the review surfaces a gap):** the reviewer gets stuck because the runbook's first-time-deployment procedure omits the exact `kmsType` value to pass at init (a plausible authoring gap) — this is treated as a real, blocking finding exactly as if a Vitest test had failed: the runbook is corrected and the review is re-run, not waived.

**Example (edge — the reviewer has prior tribal knowledge of the system):** the runbook must still be written for a reader who does *not* already know the system (the story's own goal, per its "so that" clause: recover reliably "without tribal knowledge or guesswork") — a reviewer who already knows the answer without reading the runbook does not constitute a valid pass; the review should be structured so the reviewer commits to following only the written steps, flagging (rather than silently working around) any point where they would otherwise rely on outside knowledge.

---

## Tasks / Subtasks

- [ ] Task 1: Draft `docs/runbook.md` skeleton with the seven required `##` sections (AC-1)
- [ ] Task 2: Write Vault Lifecycle section — first-time deployment, normal startup/shutdown, manual unseal, unexpected-seal triage (AC-2, AC-3, AC-4, AC-5)
  - [ ] 2.1 Cross-link to `docs/operator-quickstart.md` for local-dev/hot-reload flows (D3)
- [ ] Task 3: Write Upgrades section — in-place upgrade procedure, destructive-migration identification + offline path, verbatim refusal-message reproduction (AC-6, AC-7)
  - [ ] 3.1 Confirm exact command name via Story 9.3's shipped `package.json` script (`pnpm check-migration-compatibility`, not epics.md's stale wording) once 9.3 merges (D2)
- [ ] Task 4: Write Backup & Recovery section — manual trigger/verify, full restore, quarterly validation, missed-backup triage (AC-8, AC-9, AC-10, AC-11)
- [ ] Task 5: Write Master Key Management section — manual rotation procedure + disclosed `key_rotated_at` limitation, lost-key/unrecoverable statement + prevention, honest KMS-integration status (AC-12, AC-13, AC-14, D6, D7)
- [ ] Task 6: Write Incident Response section — vault-unreachable flowchart, audit-storage-95% export-and-prune, break-glass post-incident sweep, compromised-machine-key emergency revoke (AC-15, AC-16, AC-17, AC-18)
- [ ] Task 7: Write Monitoring section — Prometheus scrape config + verified (not aspirational) metric list, alert-type response table, dual audit-log verification + PJ9 boundary (AC-19, AC-20, AC-21)
- [ ] Task 8: Write Quarterly Operations Checklist section (AC-23)
- [ ] Task 9: Add `## Operations` section to root `README.md` linking to `docs/runbook.md`; update `docs/operator-quickstart.md`'s stale line-161 forward-reference (AC-22, D3)
- [ ] Task 10: Cross-reference audit pass — verify every cited endpoint/env var/command against Stories 9.1–9.4's actual merged implementations; correct any drift (AC-24, D1, D5)
- [ ] Task 11: Schedule and execute the non-author documentation review (AC-25) — requires a clean, disposable environment and a second human reviewer; not automatable

---

## Dev Notes

### Architecture Compliance

- This story adds **no code, no schema, no routes** — it is pure documentation. There is nothing to reconcile against `architecture.md`'s technical-stack/security/data-schema sections beyond accurately *describing* what those sections (and the actual shipped code) already establish.
- Follows the same "shipped code/story is authoritative over epics.md's summary prose" discipline already established twice in this epic (Stories 9.2 D2, 9.4 D2) — this story's D2 is a third instance of the same pattern (`pnpm check-migration-compatibility` vs. epics.md's `pnpm migration-compatibility-check`).
- `architecture.md`'s Infrastructure & Deployment section (lines 447-470) and Maintainability NFR (`prd.md` lines 1062-1070) are the source for the Docker/logging/metrics/12-factor claims this story documents — verified directly against `apps/api/src/routes/metrics.ts` rather than transcribed from architecture.md's prose alone, since architecture.md is confirmed stale in at least one place (the "pg-boss queue depth" metric mentioned at line 460 does not exist in code, AC-19's edge example).

### Project Structure Notes

- New file: `docs/runbook.md` (sibling to the existing `docs/operator-quickstart.md` and `docs/federated-multi-tenant-architecture-analysis.md`).
- Modified files: root `README.md` (new `## Operations` section, AC-22), `docs/operator-quickstart.md` (one-line link update, D3).
- No changes to `apps/`, `packages/`, `scripts/`, or any migration file.

### Testing Standards Summary

- No Vitest/integration tests are added or required by this story (epics.md's explicit text, D4). The sole acceptance mechanism is the human documentation review specified in AC-25.
- Markdown-lint / link-check tooling, if already present in this repo's CI (verify at implementation time), should be run against the new file as a basic hygiene check — this is not a substitute for AC-25's review, only a floor-level check that links resolve and headings are well-formed.

### Previous Story Intelligence

**Story 9.1 (Encrypted Backup & Restore, `ready-for-dev`, not yet `done`):** source of truth for every Backup & Recovery procedure (AC-8 through AC-11) — endpoint paths, request/response shapes, env var names (`BACKUP_SCHEDULE`, `BACKUP_STORAGE_PATH`, `BACKUP_S3_BUCKET`, `BACKUP_RETENTION_COUNT`, `BACKUP_MAX_AGE_HOURS`), and the `HKDF_INFO.BACKUP` key-derivation note relevant to AC-9's edge example about restoring across key rotations.

**Story 9.2 (System Settings, Multi-Org & Resource Monitoring, `ready-for-dev`, not yet `done`):** source of truth for the `key_custody_risk` alert mechanism (AC-12/AC-14), `KEY_ROTATION_MAX_AGE_DAYS`, `AUDIT_LOG_STORAGE_LIMIT_GB` and the 95%-maintenance-mode/`topContributingOrgs` mechanism (AC-16), and — critically — its own D8 is the origin of this story's D7 disclosure about `key_rotated_at` never being updated by any rotation-execution code path.

**Story 9.3 (In-Place Version Upgrades & API Parity Verification, `ready-for-dev`, not yet `done`):** source of truth for the entire Upgrades section (AC-6, AC-7) — the guarded `db:migrate` wrapper, the exact destructive-migration refusal message (reproduced verbatim in AC-7), and the real `check-migration-compatibility` script name (D2). Story 9.3's own AC-20 forward-references this story's exact deliverable path (`docs/runbook.md § Upgrades`) — this is a load-bearing dependency in the *other* direction (9.3's shipped error message literally names this story's output file).

**Story 9.4 (Platform Operator Audit Log, `ready-for-dev`, not yet `done`):** source of truth for `GET /api/v1/platform/audit/verify`, the `X-Log-Scope: platform` header, and the PJ9 cross-log-search boundary this story's AC-21 documents explicitly.

**Story 8.1 (Tamper-Evident Audit Log, `done`):** source of truth for `GET /api/v1/org/audit/verify` (the per-org counterpart cited alongside 9.4's platform log in AC-21) and the per-row-HMAC (not hash-chain) mechanism — `architecture.md`/`prd.md`'s "cryptographic chaining" language is stale relative to the actual shipped mechanism (already flagged by Story 9.4's own D6); this story's Monitoring section should use the accurate "per-row HMAC" description, not architecture.md's stale wording, if it needs to characterize the mechanism at all beyond citing the verify endpoints.

**Story 7.2 (Machine User Authentication, `done`):** source of truth for the emergency-revoke endpoint and its distinct no-overlap-window semantics vs. routine rotation (AC-18).

**Story 5.3 (Stale Rotation Recovery & Break-Glass Emergency Rotation, `done`) and Story 8.5 (Rotation Web UI Hardening, `ready-for-dev`):** source of truth for the break-glass post-incident sweep checklist (AC-17), including 8.5's client-side secrets-clearing hardening finding.

**Story 1.5 (Vault Initialization & Master Key Management, `done`):** source of truth for `kmsType` values (`'passphrase' | 'envelope' | 'file' | 'kms'`), confirming `'kms'` is reserved-but-unimplemented (D6) — this is the single most important fact this story must get right, since documenting it as available would be a "lying about completion"-class defect.

### Git Intelligence (Recent Commits)

Recent commits in this worktree (`726a2d8`, `03431fa`, `9da6278`, `a62ec38`, `2513f42`) are the 6-4 completion, its CI fix, and the creation/adversarial-review of Stories 9-3 and 9-4 — confirming Epic 9's story-creation work is actively in progress but no Epic 9 code has merged yet (consistent with the grep-verified D1 finding above). No commit yet touches `docs/runbook.md` or adds a `## Operations` section to `README.md` — this is a greenfield documentation deliverable.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.5: Operational Runbook & Deployment Guide] (lines 2126-2174) — the literal AC text this story's ACs formalize with concrete commands/examples; also the Epic 9 header (PJ9 cross-log-search boundary, AC-E9b in-place-upgrade scope, AC-E9d key-custody trigger).
- [Source: _bmad-output/planning-artifacts/prd.md] (lines 1036-1043 Reliability NFR — RPO 24h/RTO 2h "with documented runbook", this story's direct justification; lines 941-942 FR49/FR50 self-hosted deployment + in-place upgrades).
- [Source: _bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md] — full Backup & Recovery source of truth (AC-8 through AC-11).
- [Source: _bmad-output/implementation-artifacts/9-2-system-settings-multi-org-and-resource-monitoring.md] — D8 (key_rotated_at limitation, this story's D7), D10 (audit-storage maintenance mode, AC-16), AC-E9d key-custody alert mechanism (AC-12/AC-14).
- [Source: _bmad-output/implementation-artifacts/9-3-in-place-version-upgrades-and-api-parity-verification.md] — D2/D3 (migration-compatibility-check naming, this story's D2), AC-3 (verbatim refusal message reproduced in AC-7), AC-20 (forward-reference to this story's exact deliverable path).
- [Source: _bmad-output/implementation-artifacts/9-4-platform-operator-audit-log.md] — platform audit verify endpoint and PJ9 boundary (AC-21).
- [Source: _bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md] — org audit verify endpoint, per-row-HMAC mechanism (not hash-chain).
- [Source: _bmad-output/implementation-artifacts/7-2-machine-user-authentication-and-programmatic-secret-retrieval.md] — emergency-revoke endpoint and semantics (AC-18).
- [Source: _bmad-output/implementation-artifacts/5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md, 8-5-rotation-web-ui-hardening.md] — break-glass procedure and its client-side hardening fix (AC-17).
- [Source: _bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md] — `kmsType` enum values, confirming `'kms'` is reserved/unimplemented (D6).
- [Source: docs/operator-quickstart.md] — existing zero-to-eval-ready guide this story cross-links rather than duplicates (D3); line 161's stale forward-reference to this story, updated by AC-22.
- [Source: README.md] — current structure (no `## Operations` section exists today, confirmed by grep); AC-22's insertion point.
- [Source: Makefile, docker-compose.yml, docker-compose.prod.yml] — `make bootstrap-docker`, `make docker-prod`, `make db-migrate`, `make ci` targets cited across AC-2, AC-3, AC-6.
- [Source: apps/api/src/routes/metrics.ts, apps/api/src/lib/db-pool-metrics.ts, apps/api/src/modules/rotation/metrics.ts] — the actual, verified-in-code Prometheus metric set (AC-19), confirming `architecture.md`'s "pg-boss queue depth" mention is stale/aspirational.
- [Source: _bmad-output/planning-artifacts/architecture.md] (Infrastructure & Deployment, lines 447-470) — Docker/logging/metrics/CI claims this story documents, cross-checked against actual code rather than transcribed uncritically.
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — Product Surface Contract rules applied above (`none` scope, docs-only).
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide for Story 9.5 covering: an explicit disclosure that this story's *drafting* can proceed now while its *acceptance* (a non-author documentation review, AC-25) is hard-blocked on Stories 9.1–9.4 actually merging (D1); a corrected command name (`pnpm check-migration-compatibility`) where epics.md's literal prose is stale relative to Story 9.3's actual shipped script (D2), continuing the same drift-correction discipline already established twice elsewhere in Epic 9; a clear division of labor between the new `docs/runbook.md` and the pre-existing `docs/operator-quickstart.md` so the two documents cross-link instead of duplicating (D3); an honest, non-aspirational documentation stance on external KMS integration being unimplemented (D6) and on master-key rotation being a manual procedure with a disclosed, already-known limitation that it cannot clear the FR109 age-based alert (D7, inherited from Story 9.2's own D8); and 25 acceptance criteria, one per runbook subsection plus cross-reference/README-link/quarterly-checklist/documentation-review criteria, each with a concrete positive example (a literal command/response transcript wherever possible) and at least one negative or edge-case example surfacing a real, already-identified gap or failure mode rather than a hypothetical one.

### File List
