#!/usr/bin/env bash
# Story 66.20: the PR-time e2e smoke gate. Decides whether ci.yml's `PR e2e smoke` job runs, and
# writes `run=true|false` to $GITHUB_OUTPUT plus a one-line reason to $GITHUB_STEP_SUMMARY.
#
# Rules:
#   - push, workflow_dispatch, merge_group                -> run (always)
#   - pull_request touching a gated path (old OR new path of a rename) -> run
#   - pull_request with no changed files                  -> skip (labelled)
#   - pull_request touching only other paths              -> skip (labelled)
#   - zero/missing/unknown base SHA, git diff failure, unknown event -> run (fail OPEN) + ::warning::
#
# A path filter on the whole workflow would stop the required checks too, so the gate lives at job
# level: a job skipped by `if:` reports as skipped, which GitHub treats as passing.
#
# Inputs (env): EVENT_NAME, BASE_SHA (PR base), HEAD_SHA (default HEAD), GITHUB_OUTPUT and
#               GITHUB_STEP_SUMMARY (both print to stdout when unset, for local proof runs).
# Needs a checkout with enough history to contain both commits (fetch-depth: 0).
set -euo pipefail

output_file="${GITHUB_OUTPUT:-}"
summary_file="${GITHUB_STEP_SUMMARY:-}"
event_name="${EVENT_NAME:-unknown}"
base_sha="${BASE_SHA:-}"
head_sha="${HEAD_SHA:-HEAD}"

# The single list of gated path prefixes (whole subtrees, never file-by-file). It covers the
# surfaces journeys assert on: UI copy, routes, components, the e2e suite itself, the extension
# manifest/API fixtures, the compose stack and its boot script, and this workflow. Two API trees
# are included beyond the story's list because historical breaks came from them: the extension
# status envelope J24 pins exactly (30.1 clockSkew, 68-8 apiRoutes) and the register/login
# anti-enumeration responses (1.20). Other API-only contract changes are a known residual gap.
GATED_PREFIXES=(
  "apps/web/messages/"
  "apps/web/src/"
  "apps/web/e2e/"
  "apps/web/playwright.config.ts"
  "packages/extension-api/src/"
  "apps/api/src/extensions/"
  "apps/api/src/auth/"
  "fixtures/"
  "docker-compose"
  "scripts/e2e-stack.sh"
  "scripts/pr-e2e-smoke-gate.sh"
  ".github/workflows/ci.yml"
)

append() {
  # $1 = target file, $2 = line. An unset target (local proof run) writes to stdout instead.
  if [[ -n "$1" ]]; then
    echo "$2" >> "$1"
  else
    echo "$2"
  fi
}

emit() {
  # $1 = run value, $2 = summary line
  append "$output_file" "run=$1"
  append "$summary_file" "$2"
}

fail_open() {
  # Collapse newlines: a workflow command annotation must stay on one line.
  echo "::warning::PR e2e smoke gate: $1; running the smoke job anyway"
  emit true "Running: $1, failing open on ${event_name}"
  exit 0
}

case "$event_name" in
  push | workflow_dispatch | merge_group)
    emit true "Running: ${event_name} always runs the e2e smoke job"
    exit 0
    ;;
  pull_request) ;;
  *) fail_open "unexpected event ${event_name}" ;;
esac

if [[ -z "$base_sha" || "$base_sha" =~ ^0+$ ]]; then
  fail_open "no usable base SHA (${base_sha:-empty})"
fi

if ! diff_output="$(git diff --name-status -M "${base_sha}...${head_sha}" 2>&1)"; then
  fail_open "changed-file lookup failed (${diff_output//$'\n'/ })"
fi

if [[ -z "$diff_output" ]]; then
  emit false "Skipped: no changed files between ${base_sha:0:7} and ${head_sha:0:7}"
  exit 0
fi

# Each line is "<status>\t<path>" or, for a rename/copy, "<status>\t<old>\t<new>": check every path.
while IFS=$'\t' read -r -a fields; do
  for path in "${fields[@]:1}"; do
    for prefix in "${GATED_PREFIXES[@]}"; do
      if [[ "$path" == "$prefix"* ]]; then
        emit true "Running: ${path} is an e2e-relevant path"
        exit 0
      fi
    done
  done
done <<< "$diff_output"

emit false "Skipped: no e2e-relevant path changed (gated: ${GATED_PREFIXES[*]}); a manual run is always possible with workflow_dispatch"
