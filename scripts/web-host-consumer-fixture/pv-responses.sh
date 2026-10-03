#!/usr/bin/env bash
# Story 68.6 AC-3: the real-server comparison for PV's own packed web-host (no pack). Sourced by
# run.sh for the `pv-responses` variant after the built server is up. Records, for a fixed list of
# requests, the status, `location`, the security headers and `set-cookie`, plus whether Kit's
# default error log line appeared on the server's stderr for an unmatched route (PV defines no
# `handleError`, so SvelteKit's default must still log). The JSON goes to
# WEB_HOST_FIXTURE_RESPONSES_OUT (default: the temp dir); with WEB_HOST_FIXTURE_RESPONSES_EXPECTED it
# is diffed against that file. pv-responses.main.json was recorded from `main`'s packed web-host
# (c4482a44) with this same script: scripts/check-composition-kit-integration.test.ts diffs the
# current packed web-host against it.
# Uses run.sh's WORK, API_PORT, NODE_BIN, log.

# <name> <method> <path> <cookie> <vault-state>
PV_RESPONSE_CASES=(
  'login-anonymous GET /login - ready'
  'register-anonymous GET /register - ready'
  'status-public GET /status/abc - ready'
  'handoff-anonymous GET /handoff - ready'
  'dashboard-anonymous GET /dashboard - ready'
  'dashboard-session-expired GET /dashboard refresh-token=dead ready'
  'dashboard-authenticated-data GET /dashboard/__data.json session=ok ready'
  'login-authenticated GET /login session=ok ready'
  'panel-anonymous GET /extensions/panels/group - ready'
  'panel-authenticated GET /extensions/panels/group session=ok ready'
  'settings-action-anonymous POST /settings - ready'
  'dashboard-sealed GET /dashboard session=ok sealed'
  'unmatched GET /nonexistent - ready'
)

pv_record_responses() {
  local port="$1" entry name method path cookie vault
  local dir="$WORK/pv-responses"
  mkdir -p "$dir"
  for entry in "${PV_RESPONSE_CASES[@]}"; do
    read -r name method path cookie vault <<< "$entry"
    curl -s -o /dev/null "http://127.0.0.1:${API_PORT}/__fixture/vault/${vault}"
    local args=(-s -o /dev/null -D "$dir/$name.headers" -X "$method"
      -H "origin: http://127.0.0.1:${port}" -H 'content-type: application/x-www-form-urlencoded')
    if [[ "$cookie" != '-' ]]; then
      args+=(-H "cookie: ${cookie}")
    fi
    curl "${args[@]}" "http://127.0.0.1:${port}${path}" || true
  done
  curl -s -o /dev/null "http://127.0.0.1:${API_PORT}/__fixture/vault/ready"
  sleep 0.5
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const [dir, stderrFile, out, ...names] = process.argv.slice(1)
    const KEEP = ["location", "content-security-policy", "x-frame-options", "referrer-policy", "permissions-policy"]
    const responses = {}
    for (const name of names) {
      const lines = fs.readFileSync(`${dir}/${name}.headers`, "utf8").split(/\r?\n/)
      const status = Number((lines[0] ?? "").split(" ")[1])
      const headers = {}
      const cookies = []
      for (const line of lines.slice(1)) {
        const at = line.indexOf(":")
        if (at < 0) continue
        const key = line.slice(0, at).trim().toLowerCase()
        const value = line.slice(at + 1).trim()
        if (key === "set-cookie") cookies.push(value)
        else if (KEEP.includes(key)) headers[key] = value
      }
      responses[name] = { status, headers, setCookie: cookies }
    }
    const stderr = fs.readFileSync(stderrFile, "utf8")
    const result = {
      responses,
      kitDefaultErrorLogged: stderr.includes("[404] GET /nonexistent"),
    }
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n")
  ' "$dir" "$WORK/server.err" "${WEB_HOST_FIXTURE_RESPONSES_OUT:-$WORK/pv-responses.json}" \
    $(for entry in "${PV_RESPONSE_CASES[@]}"; do echo "${entry%% *}"; done)
  log "OK: recorded ${#PV_RESPONSE_CASES[@]} PV responses"
  local recorded="${WEB_HOST_FIXTURE_RESPONSES_OUT:-$WORK/pv-responses.json}"
  if ! grep -q '"kitDefaultErrorLogged": true' "$recorded"; then
    echo "fixture: Kit's default error log line is missing for an unmatched route" >&2
    exit 1
  fi
  if [[ -n "${WEB_HOST_FIXTURE_RESPONSES_EXPECTED:-}" ]]; then
    if ! diff -u "$WEB_HOST_FIXTURE_RESPONSES_EXPECTED" "$recorded" >&2; then
      echo "fixture: PV's responses differ from the main snapshot" >&2
      exit 1
    fi
    log "OK: PV's responses equal the main snapshot"
  fi
  return 0
}
