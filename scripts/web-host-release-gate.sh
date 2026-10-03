#!/usr/bin/env bash
# Story 68.12 AC-4 (D1): the release gate of web-host-release.yml, shared by its `publish-kit` and
# `publish` jobs. A tag push starts that workflow at H2, before the GitHub Release exists; this gate
# refuses to let a job upload until, for this tag and commit:
#   1. the GitHub Release is published (not missing, not a draft: H3 done), and
#   2. container-publish.yml has a successful `release`-event run whose head_branch is this tag
#      (container-publish is dispatched from main, so a dispatch run's head_sha is main's tip, not
#      the tag it built: only a release-event run for this tag counts).
# Any GitHub API error, or output it cannot parse, fails closed ("retry the failed jobs").
#
# Inputs (env, all set by the runner or the step's `env:` block, never templated in here):
#   GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_SHA  the tag, repo and attested commit
#   GH_TOKEN                                        read by gh (needs actions: read)
#   REPORT_ONLY                                     `1` on a workflow_dispatch dry run: report the
#                                                   missing conditions and exit 0
#
# Usage: ./scripts/web-host-release-gate.sh
# Requires: gh, jq.
# No `-e`: every failing command is checked explicitly, so each failure gets its own message.
set -uo pipefail

api_error() {
  local detail="$1"
  echo "ERROR: GitHub API error; retry the failed jobs. $detail" >&2
  return 0
}

MISSING=0
if ! RELEASE_JSON="$(gh release view "$GITHUB_REF_NAME" --json isDraft,isPrerelease,tagName 2>&1)"; then
  if ! grep -q 'release not found' <<< "$RELEASE_JSON"; then
    api_error "$RELEASE_JSON"
    exit 1
  fi
  echo "Release: missing (expected before H3)"
  MISSING=1
elif ! IS_DRAFT="$(jq -er '.isDraft | tostring' <<< "$RELEASE_JSON")"; then
  api_error "unexpected gh release view output: $RELEASE_JSON"
  exit 1
elif [[ "$IS_DRAFT" != "false" ]]; then
  echo "Release: draft, not published (H3 not done)"
  MISSING=1
else
  echo "Release: published"
fi

if ! RUNS_JSON="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/container-publish.yml/runs?head_sha=$GITHUB_SHA&event=release&per_page=100" 2>&1)"; then
  api_error "$RUNS_JSON"
  exit 1
fi
if ! GREEN="$(jq -e --arg tag "$GITHUB_REF_NAME" '[.workflow_runs[] | select(.conclusion == "success" and .event == "release" and .head_branch == $tag)] | length' <<< "$RUNS_JSON")"; then
  api_error "unexpected container-publish runs output"
  exit 1
fi
if [[ "$GREEN" -gt 0 ]]; then
  echo "container-publish: green for the $GITHUB_REF_NAME release at $GITHUB_SHA"
else
  echo "container-publish: missing (no successful $GITHUB_REF_NAME release run at $GITHUB_SHA yet)"
  MISSING=1
fi

if [[ "$MISSING" -eq 0 ]]; then
  exit 0
fi
if [[ "$REPORT_ONLY" == "1" ]]; then
  echo "Dry run: report only. A real run fails here until H3 and a green container-publish."
  exit 0
fi
echo "ERROR: the GitHub Release or the container release for $GITHUB_REF_NAME is missing; no version was consumed; re-run failed jobs after H3 and a green container-publish." >&2
exit 1
