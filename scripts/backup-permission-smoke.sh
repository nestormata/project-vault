#!/usr/bin/env bash
# Story 9.9 AC-6: Docker smoke coverage for the backup-volume-permission fix — proves
# apps/api/docker-entrypoint.sh's chown-then-drop-privileges behavior against the REAL built
# image (not a stubbed shell test), for both scenarios the intent-contract's I/O matrix calls out:
#   1. a fresh named volume (root-owned by default) ends up owned by the runtime uid:gid (1000:1000)
#      and writable by the non-root `node` user the app actually runs as;
#   2. an unfixable bind mount (read-only) does NOT abort the container — it still starts and the
#      entrypoint logs the documented `backup.storage_init_failed` remediation instead of crashing.
#
# Deliberately does not boot the full docker-compose stack (db/migrate/web) — this only needs the
# already-built `api` image and no database, so it stays fast enough to run inside `make ci`
# (see Makefile's `ci` target, which invokes this on the host since the containerized `ci-inner`
# step has no Docker socket to build/run nested images from — see that target's comment).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# PID-suffixed like VOLUME_NAME: this repo routinely runs several concurrent worktrees/CI
# invocations (see docker-up notes), and a fixed tag would let two simultaneous `make ci` runs
# race on building/tagging/removing the same image.
IMAGE_TAG="project-vault-api-backup-smoke:local-$$"
VOLUME_NAME="project-vault-backup-smoke-vol-$$"
BIND_DIR="$(mktemp -d)"

cleanup() {
  docker rmi -f "$IMAGE_TAG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME_NAME" >/dev/null 2>&1 || true
  rm -rf "$BIND_DIR" || true
}
trap cleanup EXIT

echo "[backup-permission-smoke] building apps/api image..."
docker build -f apps/api/Dockerfile -t "$IMAGE_TAG" . >/tmp/backup-permission-smoke-build.log 2>&1 \
  || { echo "[backup-permission-smoke] build failed:"; cat /tmp/backup-permission-smoke-build.log; exit 1; }

echo "[backup-permission-smoke] scenario 1: fresh named volume gets chowned to 1000:1000..."
docker volume create "$VOLUME_NAME" >/dev/null
STAT_OUTPUT="$(docker run --rm \
  -e BACKUP_STORAGE_PATH=/var/backups/vault \
  -v "${VOLUME_NAME}:/var/backups/vault" \
  "$IMAGE_TAG" \
  sh -c 'stat -c "%u:%g:%a" /var/backups/vault && id -u && touch /var/backups/vault/smoke-test-file && echo WRITE_OK')"
echo "$STAT_OUTPUT"
echo "$STAT_OUTPUT" | grep -q '^1000:1000:750$' \
  || { echo "[backup-permission-smoke] FAIL: fresh volume was not chowned to 1000:1000 mode 0750"; exit 1; }
echo "$STAT_OUTPUT" | grep -q '^1000$' \
  || { echo "[backup-permission-smoke] FAIL: app process did not run as uid 1000 (non-root boundary violated)"; exit 1; }
echo "$STAT_OUTPUT" | grep -q 'WRITE_OK' \
  || { echo "[backup-permission-smoke] FAIL: non-root process could not write to the repaired directory"; exit 1; }
echo "[backup-permission-smoke] scenario 1 OK"

echo "[backup-permission-smoke] scenario 2: existing backup files survive the repair untouched..."
docker run --rm -v "${VOLUME_NAME}:/var/backups/vault" "$IMAGE_TAG" \
  sh -c 'echo "existing-backup-content" > /var/backups/vault/backup_existing.vault'
docker run --rm \
  -e BACKUP_STORAGE_PATH=/var/backups/vault \
  -v "${VOLUME_NAME}:/var/backups/vault" \
  "$IMAGE_TAG" \
  sh -c 'cat /var/backups/vault/backup_existing.vault' | grep -q 'existing-backup-content' \
  || { echo "[backup-permission-smoke] FAIL: pre-existing backup file was lost/changed by the repair"; exit 1; }
echo "[backup-permission-smoke] scenario 2 OK"

echo "[backup-permission-smoke] scenario 3: unfixable (read-only) bind mount does not abort startup..."
touch "${BIND_DIR}/marker"
UNFIXABLE_OUTPUT="$(docker run --rm \
  -e BACKUP_STORAGE_PATH=/var/backups/vault \
  -v "${BIND_DIR}:/var/backups/vault:ro" \
  "$IMAGE_TAG" \
  sh -c 'echo STARTED_OK; id -u' 2>&1)"
echo "$UNFIXABLE_OUTPUT"
echo "$UNFIXABLE_OUTPUT" | grep -q 'STARTED_OK' \
  || { echo "[backup-permission-smoke] FAIL: container did not start with an unfixable bind mount"; exit 1; }
echo "$UNFIXABLE_OUTPUT" | grep -q '^1000$' \
  || { echo "[backup-permission-smoke] FAIL: app process did not run as uid 1000 even on the degraded path"; exit 1; }
echo "$UNFIXABLE_OUTPUT" | grep -q 'backup.storage_init_failed' \
  || { echo "[backup-permission-smoke] FAIL: no structured remediation warning logged for the unfixable mount"; exit 1; }
echo "$UNFIXABLE_OUTPUT" | grep -q '1000:1000' \
  || { echo "[backup-permission-smoke] FAIL: remediation warning did not state the required uid:gid"; exit 1; }
echo "[backup-permission-smoke] scenario 3 OK"

echo "[backup-permission-smoke] all scenarios passed"
