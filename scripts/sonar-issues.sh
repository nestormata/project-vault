#!/usr/bin/env bash
# List SonarCloud issues for this project via the Web API. Read-only: CI performs analysis using
# sonar-project.properties; this script only queries the most recently published results.
# Reads SONAR_TOKEN / SONAR_ORGANIZATION / SONAR_PROJECT_KEY / SONAR_HOST_URL from .env
# (git-ignored) so no credentials ever need to be typed into chat or a committed file.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${SONAR_TOKEN:?Set SONAR_TOKEN in .env — SonarCloud > My Account > Security > Generate Token}"
: "${SONAR_PROJECT_KEY:?Set SONAR_PROJECT_KEY in .env — the project key shown in SonarCloud}"

SONAR_HOST_URL="${SONAR_HOST_URL:-https://sonarcloud.io}"
STATUSES="${1:-OPEN,CONFIRMED}"

curl -sf -u "${SONAR_TOKEN}:" \
  "${SONAR_HOST_URL}/api/issues/search?componentKeys=${SONAR_PROJECT_KEY}&issueStatuses=${STATUSES}&ps=100" |
  python3 -c '
import json, sys

data = json.load(sys.stdin)
issues = data.get("issues", [])
org = data.get("organization", "")
total = data.get("total", len(issues))
print(f"{total} issue(s) with status in requested set\n")
for issue in issues:
    component = issue["component"].split(":", 1)[-1]
    line = issue.get("line", "?")
    severity = issue.get("severity") or (issue.get("impacts") or [{}])[0].get("severity", "?")
    message = issue["message"]
    rule = issue.get("rule", "")
    key = issue["key"]
    print(f"[{severity:8}] {component}:{line}")
    print(f"           {message}")
    print(f"           {rule}  ->  {org}/{key}")
    print()
'
