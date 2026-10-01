# Quarterly operations checklist

<!-- Verified against apps/api/src/main.ts (registerSchedules), apps/api/src/lib/boss.ts,
     apps/api/src/modules/backup/routes.ts, apps/api/src/modules/audit/routes.ts,
     apps/api/src/modules/platform-audit/routes.ts, .trivyignore, .github/workflows/ci.yml,
     .github/workflows/nightly.yml, .github/workflows/container-publish.yml -->

## When to use

Once per quarter, and after any incident that called the reliability of one of these mechanisms into
question. Check a box only after actually running the underlying command, not after reading its
description.

---

- [ ] **Backup restore validation.** Run
      `POST /api/v1/admin/backups/:filename/validate` against the most recent backup
      ([`backup-restore.md`](backup-restore.md)). Expected: `{"data":{"valid":true,
      "assetsPresent":{...all true...},"checksum":"match"}}`. Record pass/fail; a failure requires
      immediate escalation, not a note for next quarter.

- [ ] **Audit-log integrity check, both logs.** Run both `GET /api/v1/org/audit/verify` and
      `GET /api/v1/platform/audit/verify` ([`monitoring.md`](monitoring.md)). Expected: `failedCount`
      of `0` on both. Checking only one is an incomplete check.

- [ ] **Confirm the background scheduler is actually running.** Several alerts (dormancy, key
      custody, resource usage, audit storage) exist only as scheduled jobs — a scheduler that has
      silently stopped produces a reassuring absence of alerts. Verify against the job store rather
      than trusting the silence:

      ```sql
      -- The schedule is registered, with the cron the code expects:
      SELECT name, cron FROM pgboss.schedule
      WHERE name IN ('user/dormancy-check', 'key-custody/check', 'audit-storage/check',
                     'resource-usage/check', 'backup/health-check');

      -- And it is actually executing (recent runs, not just a registration):
      SELECT name, state, created_on, completed_on FROM pgboss.job
      WHERE name = 'user/dormancy-check' ORDER BY created_on DESC LIMIT 5;
      ```

      Expected crons: `user/dormancy-check` `0 9 * * *`, `key-custody/check` `0 5 * * 1`,
      `audit-storage/check` `0 4 * * *`, `resource-usage/check` `0 * * * *`,
      `backup/health-check` `0 * * * *` (the last is registered only when backups are enabled). The
      job query should show recent rows in state `completed`. Completed runs older than pg-boss's
      retention window move to `pgboss.archive` — query that table the same way if the active table
      looks empty. A missing schedule row, or no run at all in the last few days, means the mechanism
      is not working: restart the API and re-check before trusting any of the alerts above.

      A vacuous "no dormant users this quarter" does **not** confirm the mechanism works; this query
      does.

- [ ] **Key custody review.** Confirm `kmsType` is not `'file'` in production. Confirm the team knows
      that master-key rotation is not supported in v1 and that the only path to new key material is
      export → re-init a fresh instance → re-import, with existing backups tied to the old key
      ([`master-key.md`](master-key.md)). Re-confirm that each key artifact (both envelope halves, or
      the KMS key and its deletion protection) is where the deployment record says it is, and that at
      least one person other than the operator can reach it.

- [ ] **Secret inventory.** Confirm none of the twelve production HMAC/session secrets is still a
      dev-shaped or placeholder value, and that each is recorded in the secret manager with an owner
      ([`secret-rotation.md`](secret-rotation.md)). A production instance refuses to boot on a known
      dev value, so this is really a check that nothing has drifted into a staging or DR copy.

- [ ] **CVE scan review.** Review any currently-active `.trivyignore` entries for continued
      justification (repo root; empty by default). Do not rely solely on CI to catch this — CI's
      "Check .trivyignore entries" step only rejects entries whose `exp:` date has **already passed**;
      it does not enforce the "max 30 days out from today" convention documented in the file's own
      header comment at entry-creation time. A human quarterly review is the actual enforcement of
      that convention.

      Where the image scans run and when they block (Story 64.3). Every image scan honours
      `.trivyignore`, so an entry suppresses the finding in all four places at once:
      - **Nightly** (`nightly.yml`, "Trivy Docker Image Scan"): the `api` and `web` runner images
        and the `migrate` image, one matrix leg each, so one image's finding never hides another's.
        **Blocking** (red nightly).
      - **PR / push** (`ci.yml`, "Docker Build (amd64)"): the amd64 `api`, `web` and `migrate`
        images (`migrate` goes beyond AC-3, so a broken or vulnerable migrate stage shows up before
        release rather than at the release gate). **Blocking**
        only on a PR that changes an image input (`apps/api/Dockerfile`, `apps/web/Dockerfile`,
        `Dockerfile.ci`, `.dockerignore`, `apps/api/docker-entrypoint.sh`, `pnpm-lock.yaml`,
        `pnpm-workspace.yaml`, `scripts/materialize-deploy-runtime.mjs`, `.trivyignore`; renames
        count as a change to both paths). On every other PR and on pushes to `main` it is **advisory**: a warning
        annotation and a green job, because an unrelated PR must not go red the morning a new
        upstream CVE is published, and nightly is the gate on `main`.
      - **Release** (`container-publish.yml`): `api`, `migrate` and `web` by pushed digest, on
        `linux/amd64` and `linux/arm64`. **Blocking**: a finding stops alias promotion (see
        [`../container-images.md`](../container-images.md#release-vulnerability-gate)).
      - **Filesystem** (`ci.yml`, "Security Scan"): lockfiles only; it cannot see base-image OS
        packages, which is why the image scans exist.

      As part of this review, check the last few nightly runs and any advisory PR-scan warnings for
      findings that nobody picked up.

      Confirm the base-image refresh (`base-image-refresh.yml`; Dependabot has no docker ecosystem
      for our bare-digest pin) has produced or reviewed a PR in the last quarter. A silent refresh
      mechanism is a broken one.

- [ ] **`.trivyignore` expiry audit.** For every active entry, confirm its `exp: YYYY-MM-DD` deadline
      is not approaching without a renewal plan (same file and mechanism as the item above).

- [ ] **Disaster-recovery rehearsal (recommended annually, at minimum).** Walk
      [`disaster-recovery.md`](disaster-recovery.md) against a scratch host with a real backup. The
      parts most likely to be wrong on the day are the ones no routine operation exercises: cluster
      roles and their passwords, key material custody, and a fresh
      `VAULT_HANDOFF_INSTANCE_ID`.
