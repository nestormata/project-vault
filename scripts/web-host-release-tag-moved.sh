#!/usr/bin/env bash
# Story 68.12 AC-4: the "Fail if the tag moved" check of web-host-release.yml, shared by its
# `publish-kit` and `publish` jobs. A job may start days after the tag push (approval wait), and the
# "Protect PV release tags" ruleset restricts only tag creation, so right before the real upload this
# re-resolves the tag on origin (peeled `^{}` for an annotated tag, else the lightweight ref) and
# fails unless it still names the commit this run checked out and the provenance attests.
#
# Inputs (env, set by the runner): GITHUB_REF_NAME (the tag), GITHUB_SHA (the attested commit).
# Usage: ./scripts/web-host-release-tag-moved.sh   (from the job's checkout, which has `origin`)
# Requires: git.
set -euo pipefail

TAG_SHA="$(git ls-remote origin "refs/tags/$GITHUB_REF_NAME^{}" | cut -f1)"
if [[ -z "$TAG_SHA" ]]; then
  TAG_SHA="$(git ls-remote origin "refs/tags/$GITHUB_REF_NAME" | cut -f1)"
fi
if [[ "$TAG_SHA" != "$GITHUB_SHA" ]]; then
  echo "ERROR: tag moved after the run started; do not publish ($GITHUB_REF_NAME is ${TAG_SHA:-missing}, this run built $GITHUB_SHA)." >&2
  exit 1
fi
echo "$GITHUB_REF_NAME still names $GITHUB_SHA."
