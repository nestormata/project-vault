#!/usr/bin/env bash
# Story 66.11: the nightly's `changes` gate. Decides whether the nightly runs or is skipped, and
# writes `run=true|false` to $GITHUB_OUTPUT plus a human line to $GITHUB_STEP_SUMMARY.
#
# Rules:
#   - FORCE=true (workflow_dispatch input `force`)       -> run
#   - >= 1 commit reachable from $GITHUB_SHA in the last 24h -> run
#   - 0 commits in the last 24h                          -> skip (labelled, never a green proof)
#   - any API/CLI error                                  -> run (fail OPEN) + ::warning::
#
# Inputs (env): FORCE, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF_NAME, GH_TOKEN (read by gh),
#               GITHUB_OUTPUT and GITHUB_STEP_SUMMARY (default /dev/stdout when unset, for local
#               proof runs), NIGHTLY_GATE_SINCE (optional ISO-8601 override of "now - 24h", used
#               only to prove the skip path locally).
set -euo pipefail

output_file="${GITHUB_OUTPUT:-/dev/stdout}"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
ref_name="${GITHUB_REF_NAME:-unknown}"

emit() {
  # $1 = run value, $2 = summary line
  echo "run=$1" >> "$output_file"
  echo "$2" >> "$summary_file"
}

if [[ "${FORCE:-false}" == "true" ]]; then
  emit true "Running: forced via force=true on ${ref_name}"
  exit 0
fi

since="${NIGHTLY_GATE_SINCE:-$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)}"

if ! count="$(gh api "repos/${GITHUB_REPOSITORY}/commits?sha=${GITHUB_SHA}&since=${since}&per_page=1" --jq length 2>&1)"; then
  # Fail open: a broken check must never silently skip the nightly.
  # Collapse newlines: a workflow command annotation must stay on one line.
  echo "::warning::nightly changes gate could not read commits (${count//$'\n'/ }); running the nightly anyway"
  emit true "Running: commit lookup failed, failing open on ${ref_name}"
  exit 0
fi

if [[ ! "$count" =~ ^[0-9]+$ ]]; then
  echo "::warning::nightly changes gate got an unexpected commits response (${count}); running the nightly anyway"
  emit true "Running: unexpected commit lookup response, failing open on ${ref_name}"
  exit 0
fi

if [[ "$count" -ge 1 ]]; then
  emit true "Running: ${count} commit(s) in the last 24h on ${ref_name}"
else
  emit false "Skipped: no commits in the last 24h on ${ref_name}; this is NOT a green proof, re-run with force=true"
fi
