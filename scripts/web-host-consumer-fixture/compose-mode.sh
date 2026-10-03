#!/usr/bin/env bash
# Story 68.3 AC-12/AC-13: the composition kit integration steps, sourced by run.sh when the variant
# starts with `compose`. run.sh keeps the isolation (fresh temp dir outside the repository, env -i,
# the packed tarballs only, no workspace links); this file adds what is specific to composing:
#
#   compose            mini pack: pv-compose, paraglide compile, svelte-kit sync, svelte-check,
#                      the shipped unit tests, vite build, boot, then HTTP and CSS assertions
#   compose-types-negative   the page reads a field its load does not return: svelte-check must fail
#   compose-server-leak      a client page imports a materialized server-only module: vite build must fail
#   compose-server-twin      the same module imported from +page.server.ts: vite build must pass
#   compose-dev        the Vite dev plugin mirrors pack edits, additions and deletions over HTTP,
#                      and protects a CM (app) route added while it runs (Story 68-6 AC-8)
#   compose-hooks-leak       a client page imports virtual:pv-hooks/server: vite build must fail (68-6 AC-1)
#   compose-full-override    the pack overrides src/hooks.server.ts wholesale (68-6 AC-11): build, serve
#   compose-bad-policy       the pack's headerPolicy is invalid: composed-hooks-init.test.ts must fail
#                            before any build (68-6 AC-6, code review)
#
# Inputs (environment): COMPOSITION_KIT_TARBALL, COMPOSITION_KIT_FIXTURES (the kit's tests/fixtures
# directory), COMPOSITION_KIT_SVELTE_CHECK and COMPOSITION_KIT_TYPES_NODE (the versions PV pins).
# Uses run.sh's WORK, APP, NODE_BIN, NODE_DIR, VARIANT, clean_env, log, free_port.

compose_pack_name() {
  case "$VARIANT" in
    compose-server-leak | compose-server-twin) echo negative-pack ;;
    *) echo mini-pack ;;
  esac
  return 0
}

# The package.json of the consumer: web-host's exact dependencies and peers (run.sh builds it), plus
# the kit tarball and svelte-check. Rewrites the file run.sh generated.
compose_extend_package_json() {
  clean_env "$NODE_BIN" -e '
    const fs = require("node:fs")
    const [file, kitTarball, svelteCheck, typesNode] = process.argv.slice(1)
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    pkg.devDependencies["@project-vault/composition-kit"] = "file:" + kitTarball
    pkg.devDependencies["svelte-check"] = svelteCheck
    // svelte-check types the shipped tests, which import node: modules (web-host does not list it).
    pkg.devDependencies["@types/node"] = typesNode
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
  ' "$APP/package.json" "$COMPOSITION_KIT_TARBALL" "$COMPOSITION_KIT_SVELTE_CHECK" "$COMPOSITION_KIT_TYPES_NODE"
  return 0
}

compose_prepare_app() {
  local templates="$FIXTURE_DIR/compose-app"
  cp "$templates/svelte.config.js" "$templates/vite.config.ts" "$templates/vitest.config.ts" "$APP/"
  printf '%s\n' '{ "extends": ["./.svelte-kit/tsconfig.json", "@project-vault/web-host/tsconfig.base.json"] }' > "$APP/tsconfig.json"
  PACK="$WORK/pack"
  cp -r "$COMPOSITION_KIT_FIXTURES/$(compose_pack_name)" "$PACK"
  # A pack in a workspace resolves @project-vault/composition-kit from the install next to it.
  ln -s "$APP/node_modules" "$PACK/node_modules"
  case "$VARIANT" in
    compose-server-twin) rm -rf "$PACK/src/routes/leak" ;;
    compose-types-negative)
      sed -i 's/data\.plan/data.nope/' "$PACK/src/routes/billing/+page.svelte"
      ;;
    compose-hooks-leak)
      mkdir -p "$PACK/src/routes/hooks-leak"
      cp "$COMPOSITION_KIT_FIXTURES/hooks-leak/+page.svelte" "$PACK/src/routes/hooks-leak/"
      ;;
    compose-full-override)
      cp "$COMPOSITION_KIT_FIXTURES/full-override/hooks.server.ts" "$PACK/src/hooks.server.ts"
      ;;
    compose-bad-policy)
      # An empty header value is an integrity failure of the composed policy.
      sed -i "s/'x-cm-policy': 'on'/'x-cm-policy': ''/" "$PACK/hooks.server.ts"
      ;;
    *) ;;
  esac
  readonly PACK
  # The pack overrides PV's recovery page, so PV's own test of that page no longer applies to the
  # composed tree. Story 68-9 turns this into the lock's `excludedPvTests`; until then the fixture
  # leaves that one test directory out of its run.
  # Story 68-6: the mini pack contributes hooks and a header-policy delta, so PV's own tests that pin
  # PV's exact hooks behaviour (the whole-response oracle, the no-contribution hooks exports, the
  # direct handle tests) describe PV, not this composed app. Same 68-9 hand-off as above.
  # The pack also overrides PV's (app)/shares/[token] load, so PV's tests of that page are out too.
  VITEST_ARGS=(--exclude '**/node_modules/**' --exclude 'src/routes/*/recovery/**'
    --exclude 'src/routes/*/shares/**'
    --exclude 'src/hooks-files.test.ts' --exclude 'src/hooks.server.test.ts'
    --exclude 'src/lib/server/composition/hooks-oracle.test.ts')
  return 0
}

# Isolation: nothing may resolve from the monorepo, and the composed copy must be the one in use.
compose_assert_isolated() {
  local pkg
  for pkg in svelte @sveltejs/kit @project-vault/composition-kit; do
    case "$(realpath "$APP/node_modules/$pkg")" in
      "$WORK"/*) ;;
      *)
        echo "fixture: $pkg resolved outside the temp dir: $(realpath "$APP/node_modules/$pkg")" >&2
        exit 1
        ;;
    esac
  done
  # NODE_PATH cannot leak in: every tool runs under clean_env (env -i with only PATH and HOME).
}

compose_run() {
  log "pv-compose --pack $(basename "$PACK")"
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" \
    node_modules/@project-vault/composition-kit/dist/cli.js \
    --pack "$PACK" --module-pack "$APP")
  for dir in src static messages project.inlang inlang-plugins vendor; do
    if [[ ! -f "$APP/$dir/.pv-compose-generated" ]]; then
      echo "fixture: $dir has no do-not-edit header" >&2
      exit 1
    fi
  done
  if [[ -L "$APP/src" || -L "$APP/vendor" ]]; then
    echo 'fixture: composed directories must be copies, never symlinks' >&2
    exit 1
  fi
}

compose_pipeline_to_sync() {
  log 'paraglide compile (composed messages), svelte-kit sync'
  (
    cd "$APP"
    clean_env "$NODE_BIN" node_modules/@inlang/paraglide-js/bin/run.js compile \
      --project ./project.inlang --outdir ./src/lib/paraglide \
      --strategy cookie baseLocale --emit-ts-declarations --silent
    clean_env "$NODE_BIN" node_modules/@sveltejs/kit/svelte-kit.js sync
  )
  # Every alias must resolve to the composed copy, never to the copy inside node_modules.
  if ! grep -q 'vendor/shared/src/index.ts' "$APP/.svelte-kit/tsconfig.json" ||
    grep -q 'node_modules/@project-vault/web-host' "$APP/.svelte-kit/tsconfig.json"; then
    echo 'fixture: the shared aliases do not point at the composed vendor/shared copy' >&2
    exit 1
  fi
}

compose_svelte_check() {
  log 'svelte-check --fail-on-warnings (every composed file gets ./$types)'
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/svelte-check/bin/svelte-check \
    --tsconfig ./tsconfig.json --fail-on-warnings)
  for types in 'src/routes/billing' 'src/routes/(auth)/login'; do
    if [[ ! -e "$APP/.svelte-kit/types/$types/\$types.d.ts" ]]; then
      echo "fixture: no generated ./\$types for $types" >&2
      exit 1
    fi
  done
}

# A utility used ONLY inside the vendored shared source must reach the CSS: proves the rewritten
# shared @source works. Written into the composed copy, which is gitignored output.
compose_plant_probe() {
  printf "export const probe = 'bg-[#654321]'\n" > "$APP/vendor/shared/src/cm-probe.ts"
  return 0
}

compose_assert_css() {
  compose_assert_hook_markers
  local css
  css="$(cat "$APP"/build/client/_app/immutable/assets/*.css)"
  local needle
  for needle in '123456' 'abcdef' '654321' 'text-slate-500'; do
    if ! grep -q "$needle" <<< "$css"; then
      echo "fixture: the built CSS lacks $needle (a PV, CM or shared-source utility)" >&2
      exit 1
    fi
  done
}

# GET <path> -> body in $WORK/body.txt, status echoed.
compose_get() {
  local port="$1" path="$2"
  curl -s -o "$WORK/body.txt" -w '%{http_code}' "http://127.0.0.1:${port}${path}" || true
  return 0
}

compose_expect() { # port path status needle
  local port="$1" path="$2" expected="$3" needle="${4:-}"
  local status
  status="$(compose_get "$port" "$path")"
  if [[ "$status" != "$expected" ]]; then
    echo "fixture: GET $path answered HTTP $status, expected $expected" >&2
    exit 1
  fi
  if [[ -n "$needle" ]] && ! grep -q -- "$needle" "$WORK/body.txt"; then
    echo "fixture: GET $path did not contain: $needle" >&2
    exit 1
  fi
  return 0
}

compose_request() { # port method path [cookie|-] [origin] [form body] -> status; headers/body in $WORK
  local port="$1" method="$2" path="$3" cookie="${4:--}" origin="${5:-http://127.0.0.1:$1}"
  local form="${6:-}"
  local args=(-s -o "$WORK/body.txt" -D "$WORK/headers.txt" -X "$method"
    -H "origin: ${origin}" -H 'content-type: application/x-www-form-urlencoded')
  if [[ "$cookie" != '-' ]]; then
    args+=(-H "cookie: ${cookie}")
  fi
  if [[ -n "$form" ]]; then
    args+=(--data "$form")
  fi
  curl "${args[@]}" -w '%{http_code}' "http://127.0.0.1:${port}${path}" || true
  return 0
}

# The value of one response header of the last compose_request (empty when absent).
compose_header() {
  local header="$1"
  awk -v name="$header" '{
    sub(/\r$/, "")
    split($0, parts, ": ")
    if (tolower(parts[1]) == tolower(name)) { print substr($0, length(parts[1]) + 3); exit }
  }' "$WORK/headers.txt"
  return 0
}

compose_fail() {
  echo "fixture: $*" >&2
  cat "$WORK/headers.txt" >&2
  exit 1
}

compose_expect_redirect() { # port method path cookie status location
  local port="$1" method="$2" path="$3" cookie="$4" expected="$5" location="$6"
  local status
  status="$(compose_request "$port" "$method" "$path" "$cookie")"
  if [[ "$status" != "$expected" || "$(compose_header location)" != "$location" ]]; then
    compose_fail "$method $path ($cookie) answered HTTP $status, expected $expected to $location"
  fi
  return 0
}

# A __data.json request a handle redirected: Kit answers 200 with a JSON redirect.
compose_expect_data_redirect() { # port path cookie location
  local port="$1" path="$2" cookie="$3" location="$4"
  local status
  status="$(compose_request "$port" GET "$path" "$cookie")"
  if [[ "$status" != '200' ]] || ! grep -qF "\"type\":\"redirect\",\"location\":\"${location}\"" "$WORK/body.txt"; then
    compose_fail "GET $path ($cookie) was not a JSON redirect to $location (HTTP $status)"
  fi
  return 0
}

compose_expect_header() { # port path header value [cookie]
  local port="$1" path="$2" header="$3" value="$4" cookie="${5:--}"
  compose_request "$port" GET "$path" "$cookie" > /dev/null
  if [[ "$(compose_header "$header")" != "$value" ]]; then
    compose_fail "GET $path lacks ${header}: ${value}"
  fi
  return 0
}

compose_expect_ok() { # port method path cookie needle
  local port="$1" method="$2" path="$3" cookie="$4" needle="$5"
  local status
  status="$(compose_request "$port" "$method" "$path" "$cookie")"
  if [[ "$status" != '200' ]] || ! grep -qF -- "$needle" "$WORK/body.txt"; then
    compose_fail "$method $path ($cookie) answered HTTP $status without: $needle"
  fi
  return 0
}

# The API stub's call counters (api-stub.mjs): the CM handlers call it, the harness reads it.
fixture_stub() { # path -> body
  local path="$1"
  curl -s "http://127.0.0.1:${API_PORT}/__fixture/${path}" || true
  return 0
}

fixture_count() { # name -> count (0 when never called)
  local name="$1"
  fixture_stub state | "$NODE_BIN" -e '
    let input = ""
    process.stdin.on("data", (chunk) => (input += chunk))
    process.stdin.on("end", () => {
      const state = JSON.parse(input)
      console.log(state.counts[process.argv[1]] ?? 0)
    })
  ' "$name"
  return 0
}

fixture_expect_count() { # name expected
  local name="$1" expected="$2"
  local actual
  actual="$(fixture_count "$name")"
  if [[ "$actual" != "$expected" ]]; then
    echo "fixture: handler counter $name is $actual, expected $expected" >&2
    fixture_stub state >&2
    exit 1
  fi
  return 0
}

# Story 68-6 AC-1: the server hook marker is in the server bundle and never in the client bundle;
# the universal and client markers reach the client bundle (positive twins prove the scan works).
compose_assert_hook_markers() {
  if ! grep -rqs 'PV_HOOKS_SERVER_MARKER_6c1f0a' "$APP/build/server"; then
    echo 'fixture: the server hook marker is missing from the server bundle' >&2
    exit 1
  fi
  if grep -rqs 'PV_HOOKS_SERVER_MARKER_6c1f0a' "$APP/build/client"; then
    echo 'fixture: the server hook marker leaked into the client bundle' >&2
    exit 1
  fi
  local marker
  for marker in PV_HOOKS_UNIVERSAL_MARKER_2b9e47 PV_HOOKS_CLIENT_MARKER_93d5c1; do
    if ! grep -rqs "$marker" "$APP/build/client"; then
      echo "fixture: $marker is missing from the client bundle" >&2
      exit 1
    fi
  done
  log 'OK: server hook code stays out of the client bundle; universal/client hooks reach it'
  return 0
}

readonly CM_ANON='-'
readonly CM_EXPIRED='refresh-token=dead'
readonly CM_AUTHED='session=ok'
# The stub's refresh succeeds for this cookie and sets `session=ok` (code review 68-6).
readonly CM_REFRESHABLE='refresh-token=good'
readonly CM_HANDLERS=(cm-area-load cm-area-action cm-area-export)

# AC-9: each gated request type answers <location> for <cookie>, and no CM handler runs.
compose_gated_row() { # port cookie location
  local port="$1" cookie="$2" location="$3"
  compose_expect_redirect "$port" GET /cm-area "$cookie" 303 "$location"
  compose_expect_data_redirect "$port" /cm-area/__data.json "$cookie" "$location"
  compose_expect_redirect "$port" POST '/cm-area?/save' "$cookie" 303 "$location"
  compose_expect_redirect "$port" GET /cm-area/export "$cookie" 303 "$location"
  compose_expect_redirect "$port" GET '/reports/7' "$cookie" 303 "$location"
  return 0
}

# Story 68-6 AC-9 / AC-13 / AC-6 / Q5 / Q7: the AC-9 table on the real packed host, with the CM
# handler counters (a redirected request never runs a handler), the CSRF row, the CM handleFetch,
# transport, server init and handleError contributions, the CM header-policy delta and before handle.
compose_hooks_checks() {
  local port="$1" handler
  # AC-13 server init: ran exactly once, before the first request was answered.
  fixture_expect_count server-init 1
  fixture_stub reset > /dev/null

  compose_gated_row "$port" "$CM_ANON" /login
  compose_gated_row "$port" "$CM_EXPIRED" '/login?reason=session-expired'
  fixture_stub vault/sealed > /dev/null
  compose_gated_row "$port" "$CM_ANON" /vault
  compose_gated_row "$port" "$CM_AUTHED" /vault
  fixture_stub vault/ready > /dev/null
  # CSRF: a cross-origin form POST is refused by Kit before any hook, even when signed in.
  if [[ "$(compose_request "$port" POST '/cm-area?/save' "$CM_AUTHED" http://evil.example)" != '403' ]]; then
    compose_fail 'a cross-origin form POST to /cm-area?/save was not refused with 403'
  fi
  for handler in "${CM_HANDLERS[@]}" cm-reports-load; do
    fixture_expect_count "$handler" 0
  done

  # Authenticated: each handler runs exactly once; handleFetch, transport and the policy apply.
  compose_expect_ok "$port" GET /cm-area "$CM_AUTHED" 'CM area for a signed-in user: 5 USD'
  [[ "$(compose_header permissions-policy)" == 'payment=(self)' ]] ||
    compose_fail 'the CM header-policy rule did not reach /cm-area'
  [[ "$(compose_header x-cm-policy)" == 'on' ]] || compose_fail 'the CM default header is missing'
  fixture_expect_count cm-area-load 1
  if ! fixture_stub state | grep -q '"cm-area-load":"1"'; then
    compose_fail "the CM handleFetch header did not reach the API on the load's fetch"
  fi
  compose_expect_ok "$port" GET /cm-area/__data.json "$CM_AUTHED" '"Money"'
  fixture_expect_count cm-area-load 2
  fixture_stub reset > /dev/null
  # curl sends `accept: */*`, so Kit answers the action with its JSON action result.
  compose_expect_ok "$port" POST '/cm-area?/save' "$CM_AUTHED" '"type":"success"'
  fixture_expect_count cm-area-action 1
  compose_expect_ok "$port" GET /cm-area/export "$CM_AUTHED" '"cmExport":true'
  fixture_expect_count cm-area-export 1
  compose_expect_ok "$port" GET /reports/7 "$CM_AUTHED" 'CM report 7'
  compose_expect_redirect "$port" GET /go/settings "$CM_ANON" 303 /login
  compose_expect_header "$port" /cm-area x-cm-before PV_HOOKS_SERVER_MARKER_6c1f0a
  compose_expect_header "$port" /billing x-cm-policy on
  compose_expect_header "$port" /billing x-frame-options DENY
  [[ -z "$(compose_header permissions-policy)" ]] || compose_fail '/billing got the cm-area rule'
  compose_expect_header "$port" /login x-cm-policy on

  # Q7: a CM handleError replaces Kit's default logging (by design); it ran, Kit's line did not.
  if [[ "$(compose_request "$port" GET /cm-boom)" != '500' ]]; then
    compose_fail 'GET /cm-boom did not answer 500'
  fi
  sleep 0.5
  fixture_expect_count handle-error-500 1
  if grep -qF '[500] GET /cm-boom' "$WORK/server.err"; then
    echo "fixture: Kit's default error log ran although CM contributed handleError" >&2
    exit 1
  fi
  log 'OK: AC-9 table (anonymous, session-expired, sealed, authenticated, CSRF) with handler counters; handleFetch, transport, init, handleError and the CM policy applied'
  compose_review_rows "$port"
  return 0
}

# The response of the last compose_request carries this Set-Cookie value (exact prefix match).
compose_expect_set_cookie() { # value-prefix context
  local prefix="$1" context="$2"
  if ! grep -qiF "set-cookie: ${prefix}" "$WORK/headers.txt"; then
    compose_fail "${context}: the refreshed cookie (${prefix}) was not forwarded"
  fi
  return 0
}

# The stub saw no request for an API path since its last reset.
fixture_expect_no_path() { # /path context
  local path="$1" context="$2"
  if fixture_stub state | grep -qF "$path"; then
    compose_fail "${context}: the API saw ${path}"
  fi
  return 0
}

# Story 68-6 code review: the remaining AC-9 rows on the real packed host. protectedPaths.add and
# .remove, a CM override of a PV (app) route outside PV's prefixes, refreshed cookies forwarded on a
# protected CM route and onto an immutable proxied Response, and a rerouted form action.
compose_review_rows() {
  local port="$1"
  fixture_stub reset > /dev/null
  # protectedPaths.add: a CM page outside (app) is protected on purpose.
  compose_expect_redirect "$port" GET /public-cm "$CM_ANON" 303 /login
  compose_expect_ok "$port" GET /public-cm "$CM_AUTHED" 'CM public-cm page'
  # protectedPaths.remove: the callback-shaped route is reachable anonymously; its sibling is not.
  compose_expect_ok "$port" GET /cm-area/callback "$CM_ANON" 'cm-callback reached'
  fixture_expect_count cm-callback 1
  compose_expect_redirect "$port" GET /cm-area/export "$CM_ANON" 303 /login

  # A CM override of PV's (app)/shares/[token]: derived, so the HOOK answers (the reason and the
  # vault redirect only come from the hook, never from the (app) layout).
  compose_expect_redirect "$port" GET /shares/tok "$CM_EXPIRED" 303 '/login?reason=session-expired'
  fixture_stub vault/sealed > /dev/null
  compose_expect_redirect "$port" GET /shares/tok "$CM_ANON" 303 /vault
  fixture_stub vault/ready > /dev/null
  fixture_expect_count cm-shares-load 0
  compose_expect_ok "$port" GET /shares/tok "$CM_AUTHED" 'This share link is invalid'
  fixture_expect_count cm-shares-load 1

  # A successful refresh: the refreshed cookie is forwarded on a protected CM route...
  compose_expect_ok "$port" GET /cm-area "$CM_REFRESHABLE" 'CM area for a signed-in user'
  compose_expect_set_cookie 'session=ok; Path=/; HttpOnly' 'GET /cm-area'
  # ...and onto the immutable Response a CM `after` handle proxied with fetch() (no 500).
  compose_expect_ok "$port" GET /cm-proxy "$CM_REFRESHABLE" '"proxied":true'
  compose_expect_set_cookie 'session=ok; Path=/; HttpOnly' 'GET /cm-proxy'

  # Reroute (Q5): an anonymous form action on /go/settings/language never runs (no API call);
  # signed in, the same action runs and reaches the API (positive twin).
  fixture_stub reset > /dev/null
  local status
  status="$(compose_request "$port" POST '/go/settings/language?/updateLocale' "$CM_ANON" '' 'locale=es')"
  if [[ "$status" != '303' || "$(compose_header location)" != '/login' ]]; then
    compose_fail "anonymous POST /go/settings/language?/updateLocale answered HTTP $status"
  fi
  fixture_expect_no_path '/api/v1/users/me/locale' 'the rerouted anonymous action'
  status="$(compose_request "$port" POST '/go/settings/language?/updateLocale' "$CM_AUTHED" '' 'locale=es')"
  if ! fixture_stub state | grep -q '/api/v1/users/me/locale'; then
    compose_fail "the signed-in rerouted action did not reach the API (HTTP $status)"
  fi
  log 'OK: protectedPaths add/remove, CM shares override, refreshed cookies (incl. an immutable proxied response) and the rerouted action'
  return 0
}

# Story 68-6 AC-8 (Elicitation 3): every derived route id is a route Kit knows (after svelte-kit
# sync); a derived id Kit does not know is a silent protection gap.
compose_assert_derived_routes() {
  clean_env "$NODE_BIN" -e '
    const fs = require("node:fs")
    const [lockFile, metaFile] = process.argv.slice(1)
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"))
    const derived = (lock.contributions.protectedPaths?.derived ?? []).map((r) => r.routeId)
    const kit = Object.keys(JSON.parse(fs.readFileSync(metaFile, "utf8")))
    const unknown = derived.filter((id) => !kit.includes(id))
    if (derived.length === 0 || unknown.length > 0) {
      console.error("fixture: derived route ids Kit does not know: " + JSON.stringify(unknown))
      console.error("derived: " + JSON.stringify(derived))
      console.error("kit: " + JSON.stringify(kit))
      process.exit(1)
    }
    console.log("fixture[compose]: OK: " + derived.length + " derived route ids are all Kit routes")
  ' "$APP/composition.lock.json" "$APP/.svelte-kit/types/route_meta_data.json"
  return 0
}

# Story 68-6 AC-11: the full override's own handle is what Kit uses, PV's pipeline (rebuilt from the
# importable pieces) still gates the derived CM routes, and the opted-in CM handle still runs.
compose_full_override_checks() {
  local port="$1"
  compose_expect_header "$port" /billing x-cm-override full
  [[ -z "$(compose_header x-cm-policy)" ]] || compose_fail 'the pack headerPolicy applied through an override that did not opt in'
  compose_expect_redirect "$port" GET /cm-area "$CM_ANON" 303 /login
  [[ "$(compose_header x-cm-before)" == 'PV_HOOKS_SERVER_MARKER_6c1f0a' ]] ||
    compose_fail 'the opted-in CM handle did not run'
  compose_expect_ok "$port" GET /cm-area "$CM_AUTHED" 'CM area for a signed-in user'
  log 'OK: a full override of src/hooks.server.ts composes, builds, serves and keeps derived protection'
  return 0
}

compose_http_checks() {
  local port="$1"
  if [[ "$VARIANT" == 'compose-full-override' ]]; then
    compose_full_override_checks "$port"
    return 0
  fi
  compose_hooks_checks "$port"
  compose_expect "$port" /login 200 'Use your Acme account to continue.'
  compose_expect "$port" /billing 200 'Acme plan: pro'
  compose_expect "$port" /billing 200 'data-testid="health-tile"'
  compose_expect "$port" /billing/export 200 '"exported":true'
  compose_expect "$port" /recovery 200 'Acme recovery'
  compose_expect "$port" /status/abc 404 ''
  log "OK: /login, /billing, /billing/export, /recovery served; the removed /status route is 404"
  return 0
}

# Dev mode (AC-13): the plugin composes on start and mirrors pack edits, additions and deletions.
compose_wait_for() { # port path needle seconds
  local port="$1" path="$2" needle="$3" seconds="$4"
  local _
  for _ in $(seq 1 "$seconds"); do
    if [[ "$(compose_get "$port" "$path")" == '200' ]] && grep -q -- "$needle" "$WORK/body.txt"; then
      return 0
    fi
    sleep 1
  done
  echo "fixture: GET $path never contained: $needle" >&2
  return 1
}

compose_dev() {
  local port api_port
  api_port="$1"
  port="$(free_port)"
  log "vite dev on 127.0.0.1:$port"
  (
    cd "$APP"
    exec env -i PATH="$NODE_DIR:/usr/bin:/bin" HOME="$WORK/home" PV_FIXTURE_DEV=1 \
      PV_FIXTURE_PACK="$PACK" PV_FIXTURE_HOST="$INSTALLED" API_BASE_URL="http://127.0.0.1:$api_port" \
      "$NODE_BIN" node_modules/vite/bin/vite.js dev --port "$port" --strictPort --host 127.0.0.1 \
      > "$WORK/dev.out" 2> "$WORK/dev.err"
  ) &
  DEV_PID=$!
  compose_wait_for "$port" /billing 'Acme plan: pro' 180
  log 'dev: edit a pack file'
  sed -i 's/Acme plan:/Acme tier:/' "$PACK/src/lib/cm-format.ts"
  compose_wait_for "$port" /billing 'Acme tier: pro' 60
  log 'dev: add an M2 route'
  mkdir -p "$PACK/src/routes/reports"
  printf '<h1>Acme reports</h1>\n' > "$PACK/src/routes/reports/+page.svelte"
  compose_wait_for "$port" /reports 'Acme reports' 60
  # Story 68-6 AC-8: a CM route added under (app) while dev runs is protected without a manual
  # restart (the composer re-derives it into the lock; pvHooks() restarts the dev server).
  log 'dev: add a CM (app) route'
  mkdir -p "$PACK/src/routes/(app)/cm-new"
  printf '<h1>CM new</h1>\n' > "$PACK/src/routes/(app)/cm-new/+page.svelte"
  local started _
  started="$(date +%s)"
  for _ in $(seq 1 90); do
    if [[ "$(compose_request "$port" GET /cm-new)" == '303' && "$(compose_header location)" == '/login' ]]; then
      log "OK: dev mode protected a CM (app) route added while running ($(($(date +%s) - started)) s)"
      break
    fi
    sleep 1
  done
  if [[ "$(compose_header location)" != '/login' ]]; then
    echo 'fixture: a CM (app) route added in dev mode was never protected by the hook' >&2
    cat "$WORK/dev.err" >&2
    return 1
  fi
  log 'dev: delete an override (the PV page must come back)'
  rm "$PACK/src/routes/(auth)/recovery/+page.svelte"
  for _ in $(seq 1 60); do
    if [[ "$(compose_get "$port" /recovery)" == '200' ]] && ! grep -q 'Acme recovery' "$WORK/body.txt"; then
      log 'OK: dev mode mirrored an edit, an addition and a deleted override'
      kill "$DEV_PID" 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  echo 'fixture: deleting the override did not restore the PV recovery page' >&2
  cat "$WORK/dev.err" >&2
  return 1
}
