#!/bin/sh
# Story 9.9: narrow root-run entrypoint. The image's runner stage no longer sets a top-level
# `USER node` (see Dockerfile) — the container now starts as root ONLY long enough to repair
# ownership of the single configured filesystem backup directory (a fresh/recreated
# `backup_data` named volume, or a misconfigured bind mount, can be root-owned, which otherwise
# produces an opaque EACCES from atomicFileWrite's `.tmp-*` write — see
# apps/api/src/modules/backup/atomic-write.ts and storage-errors.ts), then immediately drops
# privileges to the non-root `node` user (uid/gid 1000:1000, baked into the base image) via
# `su-exec` before `exec`ing the real app process. The app itself NEVER runs as root — this is
# the one and only place privilege drop happens, and it happens before exec, not after.
#
# Scope discipline (AC-2 / Never clause): this touches ONLY the directory named by
# BACKUP_STORAGE_PATH, non-recursively into any other host path, and only mkdir/chown/chmod on
# that single directory itself — never a recursive chown of its contents (existing backup files
# already have correct ownership from prior atomic writes as the same node user; only the
# directory entry itself can be wrong on a fresh volume). It is intentionally NOT a general-purpose
# recursive host-path chown utility.
set -eu

TARGET_UID=1000
TARGET_GID=1000

# JSON-string-escape a value for embedding in the hand-built log lines below: backslash and
# double-quote must be escaped, and newlines/CRs (which can appear in captured stderr) collapsed
# to spaces so a multi-line error can't break the single-line JSON envelope.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r' '  '
}

path="${BACKUP_STORAGE_PATH:-}"
# Trim leading/trailing whitespace so a whitespace-only value (e.g. from a misrendered compose
# template) is treated as unset rather than as a literal " " path.
trimmed_path="$(printf '%s' "$path" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -n "$trimmed_path" ]; then
  case "$trimmed_path" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/app|/app/*)
      # Refuse to touch a handful of well-known critical system/app paths as a last-resort guard
      # against a misconfigured BACKUP_STORAGE_PATH turning the narrow, single-directory chown/
      # chmod below into damage against the container's own filesystem. This never aborts
      # startup (AC-2) — it just skips storage init the same way an unfixable-mount failure does.
      echo "{\"level\":\"warn\",\"event\":\"backup.storage_init_failed\",\"stage\":\"validate\",\"path\":\"$(json_escape "$trimmed_path")\",\"error\":\"refusing to chown/chmod a well-known system path\",\"remediation\":\"Point BACKUP_STORAGE_PATH at a dedicated backup directory, not a system/application root.\"}" >&2
      ;;
    *)
      # -p: idempotent, no-op if it already exists (AC-1 edge case: an existing destination with
      # valid backups must be repaired in place, never recreated/emptied). Errors are captured via
      # command substitution (not a redirect to a predictable /tmp path) so this works even when
      # /tmp itself is read-only, and a failure here still falls through to `exec` below rather
      # than aborting the script under `set -e`.
      if mkdir_err="$(mkdir -p "$trimmed_path" 2>&1)"; then
        # Restrictive owner/group mode (0750): never world-writable/readable. Applied only to the
        # directory entry itself, not recursively — pre-existing files inside it keep whatever
        # mode they were written with by atomicFileWrite (0644 default from writeFile).
        if chown_err="$(chown "${TARGET_UID}:${TARGET_GID}" "$trimmed_path" 2>&1 && chmod 0750 "$trimmed_path" 2>&1)"; then
          :
        else
          # Do NOT abort startup — an unfixable bind mount (AC-2) must still let the container
          # start and serve /health; only the backup path degrades. The classified
          # storage-errors.ts message at backup-attempt time repeats this same UID/GID guidance
          # to the operator via backup_runs.errorMessage / the admin backups page, so this
          # startup log is the first, not the only, place this remediation is surfaced.
          echo "{\"level\":\"warn\",\"event\":\"backup.storage_init_failed\",\"stage\":\"chown\",\"path\":\"$(json_escape "$trimmed_path")\",\"requiredUid\":${TARGET_UID},\"requiredGid\":${TARGET_GID},\"error\":\"$(json_escape "$chown_err")\",\"remediation\":\"This mount cannot be chowned by the container (likely a bind mount owned by a different host UID/GID, or a read-only mount). On the host, run: chown ${TARGET_UID}:${TARGET_GID} <host-path-for-BACKUP_STORAGE_PATH>. See docs/runbook.md \\u2018Backup permission remediation\\u2019.\"}" >&2
        fi
      else
        echo "{\"level\":\"warn\",\"event\":\"backup.storage_init_failed\",\"stage\":\"mkdir\",\"path\":\"$(json_escape "$trimmed_path")\",\"requiredUid\":${TARGET_UID},\"requiredGid\":${TARGET_GID},\"error\":\"$(json_escape "$mkdir_err")\",\"remediation\":\"Create BACKUP_STORAGE_PATH on the host and chown it to ${TARGET_UID}:${TARGET_GID} (see docs/runbook.md \\u2018Backup permission remediation\\u2019), or point BACKUP_STORAGE_PATH at a writable named volume.\"}" >&2
      fi
      ;;
  esac
fi

exec su-exec node:node "$@"
