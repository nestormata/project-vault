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
#   compose-mock-pack        Story 68.10: the mock UI pack (COMPOSITION_KIT_FIXTURES/mock-ui-pack) composed,
#                            checked, verified (pv-verify guards incl. monolithic-region), built and served
#                            (compose-mock-pack.sh)
#   compose-bad-policy       the pack's headerPolicy is invalid: composed-hooks-init.test.ts must fail
#                            before any build (68-6 AC-6, code review)
#   compose-nav-drift        web-host's nav-ids.json loses an id the pack's nav delta changes: pv-compose
#                            must fail naming it (Story 68.7 AC-9/AC-13)
#   compose-nav-leak         the pack's nav.ts imports a $lib/server module: vite build must fail (the
#                            nav delta reaches the client bundle; Story 68.7 AC-8)
#
# Inputs (environment): COMPOSITION_KIT_TARBALL, COMPOSITION_KIT_FIXTURES (the kit's tests/fixtures
# directory), COMPOSITION_KIT_SVELTE_CHECK and COMPOSITION_KIT_TYPES_NODE (the versions PV pins).
# Uses run.sh's WORK, APP, NODE_BIN, NODE_DIR, VARIANT, clean_env, log, free_port.

# curl's write-out format for printing only the HTTP status code.
readonly CURL_STATUS_FORMAT='%{http_code}'
readonly SELFTEST_LABEL='self-test'

# Story 68-20: the kit's bins as a consumer runs them, through the symlinks npm creates in
# node_modules/.bin (a `#!/usr/bin/env node` script, so PATH under clean_env must hold node).
readonly KIT_BIN_DIR='node_modules/.bin'
readonly COMPOSE_LINK="$KIT_BIN_DIR/pv-compose"
readonly VERIFY_LINK="$KIT_BIN_DIR/pv-verify"

# A bin entry that is missing or a regular file cannot prove the symlink launch, so it fails.
compose_assert_bin_symlinks() {
  local bin
  for bin in "$COMPOSE_LINK" "$VERIFY_LINK"; do
    if [[ ! -L "$APP/$bin" || ! -x "$APP/$bin" ]]; then
      echo "fixture: $bin is not an executable symlink" >&2
      exit 1
    fi
  done
  return 0
}

compose_pack_name() {
  case "$VARIANT" in
    compose-server-leak | compose-server-twin | compose-replace-leak | compose-replace-first-leak) echo negative-pack ;;
    compose-mock-pack) echo mock-ui-pack ;;
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
    compose-server-leak) rm -rf "$PACK/src/routes/leak-replaced" ;;
    compose-replace-leak | compose-replace-first-leak) rm -rf "$PACK/src/routes/leak" ;;
    compose-server-twin) rm -rf "$PACK/src/routes/leak" "$PACK/src/routes/leak-replaced" ;;
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
    compose-nav-leak)
      cat "$COMPOSITION_KIT_FIXTURES/nav-leak/nav-leak.ts.txt" >> "$PACK/nav.ts"
      ;;
    compose-bad-policy)
      # An empty header value is an integrity failure of the composed policy.
      sed -i "s/'x-cm-policy': 'on'/'x-cm-policy': ''/" "$PACK/hooks.server.ts"
      ;;
    *) ;;
  esac
  readonly PACK
  # Story 68-9: a PV test whose subject the pack overrode, replaced or removed is excluded by the
  # lock's `excludedPvTests`, which the exported vitest config factory reads. A subject is a direct
  # import, the sibling, and what those reach inside src/lib (DW-493). The tests that pin PV's own
  # build (hooks-files, server-files-wiring) are not shipped, and the hooks.server tests mock the
  # contribution module, so nothing is excluded by hand here.
  VITEST_ARGS=(
    --exclude '**/node_modules/**'
  )
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

# Story 68.7 AC-13 drift variant: web-host's nav-ids.json no longer has an id the pack's nav.ts
# relabels (an operative change), so pv-compose fails naming it and writes nothing.
compose_nav_drift() {
  local ids="$INSTALLED/manifests/nav-ids.json"
  clean_env "$NODE_BIN" -e '
    const fs = require("node:fs")
    const file = process.argv[1]
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest.ids = manifest.ids.filter((entry) => entry.id !== "primary.health")
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
  ' "$ids"
  local status=0
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" \
    node_modules/@project-vault/composition-kit/dist/cli.js \
    --pack "$PACK" --module-pack "$APP") > "$WORK/drift.out" 2>&1 || status=$?
  cat "$WORK/drift.out"
  if [[ "$status" == 0 ]] ||
    ! grep -qF 'Nav id "primary.health" vanished from web-host and an operative nav change targets it' "$WORK/drift.out"; then
    echo 'fixture: pv-compose did not fail on the vanished nav id' >&2
    exit 1
  fi
  if [[ -e "$APP/composition.lock.json" ]]; then
    echo 'fixture: a failed compose wrote a lock' >&2
    exit 1
  fi
  log 'OK: a vanished operative nav id fails the compose, naming it'
  return 0
}

compose_run() {
  if [[ "$VARIANT" == 'compose-nav-drift' ]]; then
    compose_nav_drift
    exit 0
  fi
  compose_assert_bin_symlinks
  log "pv-compose (via $COMPOSE_LINK) --pack $(basename "$PACK")"
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$COMPOSE_LINK" \
    --pack "$PACK" --module-pack "$APP")
  # A silent no-op exits 0 too (the 0.7.0 symlink bug): the lock must exist.
  if [[ ! -s "$APP/composition.lock.json" ]]; then
    echo "fixture: $COMPOSE_LINK exited 0 but wrote no composition.lock.json" >&2
    exit 1
  fi
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

# Story 68.4 AC-2: an unknown injection point fails the composition against the REAL generated
# registry, and the message says the way out. A dry run writes nothing.
compose_unknown_point() {
  local bad="$WORK/pack-unknown-point"
  cp -r "$COMPOSITION_KIT_FIXTURES/mini-pack" "$bad"
  ln -s "$APP/node_modules" "$bad/node_modules"
  sed -i "s/'auth.register.after'/'project.detail.nope'/" "$bad/pv-ui.manifest.ts"
  local out status=0
  out="$(cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" \
    node_modules/@project-vault/composition-kit/dist/cli.js \
    --pack "$bad" --module-pack "$APP" --dry-run 2>&1)" || status=$?
  if [[ "$status" == '0' ]] || ! grep -q 'Injection point "project.detail.nope" does not exist' <<< "$out" ||
    ! grep -q 'a missing point never blocks you' <<< "$out"; then
    echo "fixture: an unknown injection point was not rejected as expected (exit $status): $out" >&2
    exit 1
  fi
  log 'OK: an unknown injection point fails with the way out'
  return 0
}

# Story 69.1 AC-4 / AC-9: a `hostRoutes` entry that is not a route rendering the region point fails
# the composition against the REAL generated registry, naming the point, the bad entry and the valid
# routes. A dry run writes nothing.
compose_bad_host_routes() {
  local bad="$WORK/pack-bad-host-routes"
  cp -r "$COMPOSITION_KIT_FIXTURES/mini-pack" "$bad"
  ln -s "$APP/node_modules" "$bad/node_modules"
  sed -i "s|'/(app)/projects/\[projectId\]#page'|'/(app)/projects/[projectId]#nope'|" "$bad/pv-ui.manifest.ts"
  local out status=0
  out="$(cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" \
    node_modules/@project-vault/composition-kit/dist/cli.js \
    --pack "$bad" --module-pack "$APP" --dry-run 2>&1)" || status=$?
  if [[ "$status" == '0' ]] || ! grep -qF 'injections.project.detail.tiles.hostRoutes' <<< "$out" ||
    ! grep -qF '/(app)/projects/[projectId]#nope' <<< "$out" ||
    ! grep -qF '/(app)/projects/[projectId]#page' <<< "$out"; then
    compose_fail "a bad hostRoutes entry was not rejected as expected (exit ${status}): ${out}"
  fi
  log 'OK: a hostRoutes entry that does not render the region point fails naming the point, the entry and the valid routes'
  return 0
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

# Story 68.5 AC-16: a PV-style unit test over the composed tree that imports a replaced module. It
# is written into the composed copy (gitignored output), so the kit's own vitest never sees it.
compose_plant_parity_test() {
  cp "$FIXTURE_DIR/compose-app/replacement-parity.test.ts.txt" "$APP/src/lib/replacement-parity.test.ts"
  return 0
}

# Story 68.5 AC-12: the map names a CM file that is not there. `vite build` must fail naming the fix.
compose_remove_replacement_file() {
  rm "$APP/src/lib/_cm/replacements/Footer.svelte"
  return 0
}

# Story 68.9 AC-15: the generated guard entries module is read by test code only, so it must never
# reach the app bundle (it holds reviewed carve-outs, not runtime data).
compose_assert_no_guard_entries_in_bundle() {
  if grep -rqs 'guard-entries' "$APP/build"; then
    echo 'fixture: the generated guard entries module leaked into the built app' >&2
    exit 1
  fi
  log 'OK: the generated guard entries module is absent from the built app'
  return 0
}

compose_assert_css() {
  compose_assert_hook_markers
  compose_assert_no_guard_entries_in_bundle
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
  curl -s -o "$WORK/body.txt" -w "$CURL_STATUS_FORMAT" "http://127.0.0.1:${port}${path}" || true
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
  curl "${args[@]}" -w "$CURL_STATUS_FORMAT" "http://127.0.0.1:${port}${path}" || true
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
  # An error page's serialized error names what failed.
  grep -o 'message:"[^"]*"' "$WORK/body.txt" >&2 || true
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
  compose_expect_redirect "$port" GET '/ledger/7' "$cookie" 303 "$location"
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
  for handler in "${CM_HANDLERS[@]}" cm-ledger-load; do
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
  compose_expect_ok "$port" GET /ledger/7 "$CM_AUTHED" 'CM ledger 7'
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

# Story 68.4 AC-13: the M3 mechanism on the real packed web-host. `/register` is a public page, so the
# injected markup, the contribution load (via the page's `__data.json` and the SSR HTML) and the
# injected form action are all served with no session; the layout point and the shell head meta
# prove layout-, page- and shell-scoped points together.
compose_offset() { # needle -> byte offset of the first match in $WORK/body.txt, or empty
  local needle=$1
  grep -ob -- "$needle" "$WORK/body.txt" | head -n 1 | cut -d: -f1
  return 0
}

compose_injection_checks() {
  local port="$1"
  compose_expect "$port" /register 200 'data-testid="inject-tile"'
  compose_expect "$port" /register 200 'tile-data:3'
  compose_expect "$port" /register 200 'data-testid="inject-layout"'
  compose_expect "$port" /register 200 'name="pv-fixture"'
  compose_expect "$port" /login 200 'name="pv-fixture"'
  compose_expect "$port" /register 200 ''
  local tile late
  tile="$(compose_offset 'data-testid="inject-tile"')"
  late="$(compose_offset 'data-testid="inject-late"')"
  if [[ -z "$tile" || -z "$late" ]] || ((tile >= late)); then
    echo "fixture: the injected components are not in order (tile at $tile, late at $late)" >&2
    exit 1
  fi
  compose_expect "$port" /register/__data.json 200 'healthy'
  local status
  status="$(curl -s -o "$WORK/body.txt" -w "$CURL_STATUS_FORMAT" -X POST \
    -H "Origin: http://127.0.0.1:${port}" -H 'x-sveltekit-action: true' \
    --data-urlencode 'note=hello' "http://127.0.0.1:${port}/register?/auth.register.after.share")"
  if [[ "$status" != '200' ]] || ! grep -q '"type":"success"' "$WORK/body.txt"; then
    echo "fixture: the injected action answered HTTP $status: $(cat "$WORK/body.txt")" >&2
    exit 1
  fi
  status="$(curl -s -o "$WORK/body.txt" -w "$CURL_STATUS_FORMAT" -X POST \
    -H "Origin: http://127.0.0.1:${port}" -H 'x-sveltekit-action: true' \
    "http://127.0.0.1:${port}/register?/auth.register.after.nope")"
  if [[ "$status" != '404' ]]; then
    echo "fixture: an unknown injected action answered HTTP $status, expected 404" >&2
    exit 1
  fi
  log 'OK: injected markup (in order), load data, layout point, shell head and action served'
  return 0
}

# Story 68.7 AC-16: the shipped composed-nav test validates the pack's real delta (virtual:pv-nav
# through pvNav()) on every surface, in en and es. It also runs in the full shipped-test step; run
# here on its own, its pass is visible in the job output.
compose_nav_test() {
  log 'composed-nav.test.ts over the pack nav delta'
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/vitest/vitest.mjs run --reporter=dot \
    src/lib/navigation/composed-nav.test.ts)
  log "OK: composed-nav.test.ts validated the pack's nav delta"
  return 0
}

compose_before() { # needle-a needle-b context: a must come before b in $WORK/body.txt
  local first="$1" second="$2" context="$3" a b
  a="$(compose_offset "$first")"
  b="$(compose_offset "$second")"
  if [[ -z "$a" || -z "$b" || "$a" -ge "$b" ]]; then
    compose_fail "$context: expected '$first' before '$second'"
  fi
  return 0
}

compose_absent() { # needle context
  local needle="$1" context="$2"
  if grep -qF -- "$needle" "$WORK/body.txt"; then
    compose_fail "$context: unexpected $needle"
  fi
  return 0
}

# Story 68.7 AC-13 (M5): every operation of the mini pack's nav.ts on the built server's real HTML.
compose_nav_checks() {
  # /settings: an (app) page whose load calls no API (the stub answers few endpoints), so the
  # primary nav, the settings index and the account menu all render from the real data.
  local port="$1" member='session=ok' project='/projects/p-nav'
  compose_expect_ok "$port" GET /settings "$member" 'CM Billing'
  compose_before 'CM Home' 'sm:inline">Projects' 'reorder (listed ids first)'
  compose_before 'sm:inline">Projects' 'aria-label="Search' 'reorder (unlisted keep their order)'
  compose_before 'sm:inline">Dashboard' 'CM Billing' 'insert after primary.projects'
  compose_before 'CM Ops' 'CM Reports' 'a 3-level CM group'
  compose_before 'CM Reports' 'CM Daily' 'a 3-level CM group'
  local needle
  for needle in 'data-cm-nav-icon' 'Health CM' 'CM Brand' 'CM Account Billing' 'CM seats and roles' 'CM Seats'; do
    compose_expect_ok "$port" GET /settings "$member" "$needle"
  done
  compose_absent 'CM Owners' 'a CM when (owners only) for a member'
  compose_absent '>Project Vault</a>' 'replace shell.brand.home'
  compose_absent 'SSO Domains' 'hide settings.index.sso-domains'
  compose_absent 'CM Hidden Billing' 'hide a CM item'
  # Moved under the CM group: no longer a top-level item (top-level items carry the label spans).
  compose_absent 'sm:inline">Notifications' 'move a PV item under a CM group'
  compose_expect_ok "$port" GET "$project" "$member" 'CM Project Billing'
  # Server rendering writes resolve()'s relative form (./p-nav/members); match the tail.
  compose_expect_ok "$port" GET "$project" "$member" 'p-nav/members"'
  compose_absent 'Status Page' 'remove project.status-page'
  # Server-rendered locale: PV's Spanish project tabs and CM's own relabel function.
  compose_expect_ok "$port" GET "$project" "$member; PARAGLIDE_LOCALE=es" 'Miembros'
  compose_expect_ok "$port" GET "$project" "$member; PARAGLIDE_LOCALE=es" 'Resumen'
  compose_expect_ok "$port" GET /settings "$member; PARAGLIDE_LOCALE=es" 'Salud CM'
  # A hidden item is not access control: the route behind the hidden CM item still answers.
  compose_expect "$port" /billing 200 'Acme plan'
  if ! grep -rqsF 'CM Project Billing' "$APP/build/client"; then
    compose_fail 'the CM nav module is not in the client bundle (the nav renders in the browser too)'
  fi
  if ! grep -qF '"cm.ops.reports.daily"' "$APP/composition.lock.json" ||
    ! grep -qF '"id": "primary.health"' "$APP/composition.lock.json"; then
    compose_fail 'the lock lacks navIdsDeclared / navIdsReferenced'
  fi
  # The compose notes (recorded in the lock): inheritance, the hide of an id PV does not have, and
  # how many references compose time could check.
  for needle in "nav ids: web-host defines" 'nav id \"primary.not-a-pv-item\" vanished from web-host; it is only hidden or removed' 'nav references: '; do
    if ! grep -qF -- "$needle" "$APP/composition.lock.json"; then
      compose_fail "the lock notes lack: $needle"
    fi
  done
  log 'OK: nav delta applied on /settings and a project (every operation, nested, CM when and icon), Spanish tabs and the CM relabel under es, the hidden route still served, CM nav in the client bundle'
  return 0
}

# ---------------------------------------------------------------------------------------------
# Story 68-15 (M3 on protected pages): the injection cases Story 68-4 could not run. Every helper
# below ends a failing command with an explicit message (compose_fail); a bare grep or pipeline that
# returned 1 under `set -e` once exited the whole variant silently (68-4's two reverted attempts).
# ---------------------------------------------------------------------------------------------
readonly CM_U1='session=u1'
readonly CM_U2='session=u2'
readonly ISOLATION_ROUNDS=10
readonly SETTINGS_PATH='/settings'
readonly SETTINGS_DATA_PATH='/settings/__data.json'
readonly WHO_MARKER='PV_INJECT_WHO_MARKER_71c2e4'
readonly THEME_MARKER='PV_INJECT_THEME_MARKER_5a90d3'
readonly PROJECT_MARKER='PV_INJECT_PROJECT_MARKER_c4417b'
readonly REGION_MARKER='PV_INJECT_REGION_MARKER_8e21f4'

# The body of the last compose_request must (not) contain a needle, with a message on failure.
compose_body_has() { # needle context
  local needle="$1" context="$2"
  if ! grep -qF -- "$needle" "$WORK/body.txt"; then
    compose_fail "${context}: the response lacks ${needle}"
  fi
  return 0
}

compose_body_lacks() { # needle context
  local needle="$1" context="$2"
  if grep -qF -- "$needle" "$WORK/body.txt"; then
    compose_fail "${context}: the response contains ${needle}"
  fi
  return 0
}

# Case 1, the firing half: ISOLATION_ROUNDS requests as u1 and as u2 at once (so their loads
# interleave in the one server process); each body goes to <dir>/<user>-<n>.body.
compose_fire_isolation() { # port path dir
  local port="$1" path="$2" dir="$3" round pid user
  local pids=()
  rm -rf "$dir"
  mkdir -p "$dir"
  for round in $(seq 1 "$ISOLATION_ROUNDS"); do
    for user in u1 u2; do
      curl -s -o "${dir}/${user}-${round}.body" -H "cookie: session=${user}" "http://127.0.0.1:${port}${path}" &
      pids+=($!)
    done
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || compose_fail "an isolation request (GET ${path}) did not complete"
  done
  return 0
}

# Case 1, the judging half: every body holds ONLY its own caller's marker. A body without its own
# marker fails too (two empty bodies would otherwise "pass" a no-leak check).
compose_assert_isolation() { # dir context [marker-prefix]
  local dir="$1" context="$2" prefix="${3:-iso}" user other round file
  for user in u1 u2; do
    other=u2
    if [[ "$user" == 'u2' ]]; then
      other=u1
    fi
    for round in $(seq 1 "$ISOLATION_ROUNDS"); do
      file="${dir}/${user}-${round}.body"
      if ! grep -qF -- "${prefix}:${user}" "$file"; then
        compose_fail "${context}: request ${round} as ${user} lacks its own marker ${prefix}:${user} (body starts: $(head -c 400 "$file" | tr '\n' ' '))"
      fi
      if grep -qF -- "${prefix}:${other}" "$file"; then
        compose_fail "${context}: request ${round} as ${user} contains the OTHER caller's marker ${prefix}:${other}"
      fi
    done
  done
  return 0
}

# A self-test: the command must fail AND say why (so a helper that goes silent is caught).
compose_expect_failure_message() { # needle command...
  local needle="$1" out status=0
  shift
  out="$("$@" 2>&1)" || status=$?
  if [[ "$status" == '0' ]]; then
    compose_fail "self-test: ${*} passed on deliberately broken input"
  fi
  if ! grep -qF -- "$needle" <<< "$out"; then
    compose_fail "self-test: ${*} failed without printing: ${needle} (got: ${out})"
  fi
  return 0
}

compose_isolation_checks() {
  local port="$1" dir="$WORK/isolation"
  fixture_stub reset > /dev/null
  compose_fire_isolation "$port" "$SETTINGS_PATH" "$dir/html"
  compose_assert_isolation "$dir/html" 'isolation (SSR HTML)'
  compose_fire_isolation "$port" "$SETTINGS_DATA_PATH" "$dir/data"
  compose_assert_isolation "$dir/data" 'isolation (__data.json)'
  fixture_expect_count inject-load $((ISOLATION_ROUNDS * 4))
  # The assertion can fail: a leaked marker, and a missing one, are both reported with a message.
  cp -r "$dir/html" "$dir/leaked"
  sed -i 's/iso:u1/iso:u2/' "$dir/leaked/u1-3.body"
  compose_expect_failure_message 'request 3 as u1 lacks its own marker iso:u1' compose_assert_isolation "$dir/leaked" "$SELFTEST_LABEL"
  cp "$dir/html/u2-5.body" "$dir/html/u1-4.body"
  compose_expect_failure_message "request 4 as u1 lacks its own marker iso:u1" compose_assert_isolation "$dir/html" "$SELFTEST_LABEL"
  printf 'iso:u1 iso:u2' > "$dir/html/u1-4.body"
  compose_expect_failure_message "request 4 as u1 contains the OTHER caller's marker iso:u2" compose_assert_isolation "$dir/html" "$SELFTEST_LABEL"
  log "OK: ${ISOLATION_ROUNDS} interleaved requests per user each saw only their own injected data (SSR HTML and __data.json); the assertion fails on a leak"
  return 0
}

# Case 2: an anonymous request is answered by the hook, so no contribution load runs; PV's own
# failing load short-circuits the contribution load too; an authenticated request runs it once.
compose_anonymous_counter_checks() {
  local port="$1" status
  fixture_stub reset > /dev/null
  compose_expect_redirect "$port" GET "$SETTINGS_PATH" "$CM_ANON" 303 /login
  compose_expect_redirect "$port" GET /settings/ "$CM_ANON" 308 /settings
  compose_expect_redirect "$port" GET /%73ettings "$CM_ANON" 303 /login
  compose_expect_data_redirect "$port" "$SETTINGS_DATA_PATH" "$CM_ANON" /login
  compose_expect_redirect "$port" GET "$SETTINGS_PATH" "$CM_EXPIRED" 303 '/login?reason=session-expired'
  fixture_expect_count inject-load 0
  # PV's own load fails (the stub answers 500 for this project): the contribution load never runs.
  status="$(compose_request "$port" GET /projects/p-boom "$CM_U1")"
  if [[ "$status" != '500' ]]; then
    compose_fail "GET /projects/p-boom answered HTTP ${status}, expected 500 from PV's own load"
  fi
  fixture_expect_count inject-load-guarded 0
  # The positive twins: the counters do move when the loads do run.
  compose_expect_ok "$port" GET "$SETTINGS_PATH" "$CM_U1" 'iso:u1'
  fixture_expect_count inject-load 1
  compose_expect_ok "$port" GET /projects/p-u1 "$CM_U1" "$PROJECT_MARKER"
  fixture_expect_count inject-load-guarded 1
  log 'OK: an anonymous request (page, __data.json, trailing slash, percent-encoded) never ran the injected load (counter 0), nor did a failing PV load; an authenticated request ran it once'
  return 0
}

# Case 3: the contribution load, running as u1 through the request's own fetch, asks for u2's
# project; the API's denial is rendered as a status and nothing of the other tenant is present.
compose_cross_tenant_checks() {
  local port="$1" path leaked
  fixture_stub reset > /dev/null
  for path in "$SETTINGS_PATH" "$SETTINGS_DATA_PATH"; do
    if [[ "$path" == "$SETTINGS_PATH" ]]; then
      compose_expect_ok "$port" GET "$path" "$CM_U1" 'project-status:404'
    else
      # devalue: the injected load returned {"who": ..., "project": 404}.
      compose_expect_ok "$port" GET "$path" "$CM_U1" '"project"'
      compose_body_has ',404' 'cross-tenant denial in the load data'
    fi
    for leaked in 'U2 Secret' 'p-u2' 'o-u2' 'u2@fixture'; do
      compose_body_lacks "$leaked" "cross-tenant (${path}, as u1)"
    done
  done
  if ! fixture_stub state | grep -qF 'GET /api/v1/projects/p-u2 as u1'; then
    compose_fail 'the stub did not see the projects request made with the caller (u1) cookie'
  fi
  if fixture_stub state | grep -qF 'as u2'; then
    compose_fail "the stub saw a request made with another caller's cookie"
  fi
  compose_expect_ok "$port" GET "$SETTINGS_PATH" "$CM_U2" 'project-status:200'
  log "OK: a contribution load running as u1 got the API's 404 for u2's project (the page stays 200), and no tenant data reached the HTML or __data.json"
  return 0
}

# Case 7: after the build, each injected component's marker is in the client chunk of the ONE page
# that renders its point, never in an entry chunk and never in another page's chunk.
compose_chunk_files() { # marker -> the files under build/client containing it
  local marker="$1"
  grep -rlF -- "$marker" "$APP/build/client/_app/immutable" || true
  return 0
}

compose_chunk_checks() {
  local marker files count
  local seen=''
  for marker in "$WHO_MARKER" "$THEME_MARKER" "$PROJECT_MARKER"; do
    files="$(compose_chunk_files "$marker")"
    count="$(printf '%s\n' "$files" | grep -c . || true)"
    if [[ "$count" != '1' ]]; then
      compose_fail "chunk placement: ${marker} is in ${count} client files, expected exactly the one page chunk: ${files}"
    fi
    case "$files" in
      */immutable/nodes/*) ;;
      *) compose_fail "chunk placement: ${marker} is not in a page node chunk: ${files}" ;;
    esac
    if [[ "$seen" == *"$files"* ]]; then
      compose_fail "chunk placement: ${marker} shares a page chunk with another point's component: ${files}"
    fi
    seen="${seen} ${files}"
  done
  # Story 69.1: the region fill renders inside the project page, so its marker lives in that page's one
  # node chunk (the one holding the project note), in no other file and in no entry chunk.
  local region_files project_files
  region_files="$(compose_chunk_files "$REGION_MARKER")"
  project_files="$(compose_chunk_files "$PROJECT_MARKER")"
  if [[ -z "$region_files" || "$region_files" != "$project_files" ]]; then
    compose_fail "chunk placement: ${REGION_MARKER} must be in exactly the project page chunk (got: ${region_files}; project: ${project_files})"
  fi
  local entry_dir="$APP/build/client/_app/immutable/entry" entry_status=0
  # An absent entry directory would make the grep below fail the same way as "no match": require it.
  if [[ ! -d "$entry_dir" ]]; then
    compose_fail "chunk placement: ${entry_dir} does not exist, so the entry chunks were not checked"
  fi
  grep -rlF -e "$WHO_MARKER" -e "$THEME_MARKER" -e "$PROJECT_MARKER" -e "$REGION_MARKER" "$entry_dir" > /dev/null || entry_status=$?
  if [[ "$entry_status" == '0' ]]; then
    compose_fail 'chunk placement: an injected component marker reached an entry chunk'
  fi
  if [[ "$entry_status" != '1' ]]; then
    compose_fail "chunk placement: grep over the entry chunks failed (exit ${entry_status})"
  fi
  log 'OK: each injected component lives in the client chunk of the one page that renders its point, in no entry chunk and no other page'
  return 0
}

# Cases 4, 5, 6: hydration, the theme rune and client navigation need a browser (browser-cases.mjs).
compose_browser_checks() {
  local port="$1" out status=0
  out="$("$NODE_BIN" "$FIXTURE_DIR/browser-cases.mjs" "$REPO_ROOT" "http://127.0.0.1:${port}" 2>&1)" || status=$?
  printf '%s\n' "$out"
  if [[ "$status" != '0' ]]; then
    compose_fail "the browser cases failed (exit ${status}); is Chromium installed (playwright install chromium)?"
  fi
  return 0
}

# Story 68-15 AC-10: the failure path of the helpers prints its message (never a silent exit).
compose_silent_failure_selftest() {
  local port="$1"
  compose_expect_failure_message 'answered HTTP' compose_expect_redirect "$port" GET "$SETTINGS_PATH" "$CM_U1" 303 /nowhere
  compose_expect_failure_message 'lacks nope-marker' compose_body_has 'nope-marker' "$SELFTEST_LABEL"
  compose_expect_failure_message 'handler counter inject-load is' fixture_expect_count inject-load 9999
  log 'OK: a deliberately broken assertion prints its message and fails the variant (no silent exit)'
  return 0
}

# AC-1/AC-2: the API stub's per-session identities and its org-owned projects, asked directly.
compose_stub_get() { # path cookie|- -> status; body in $WORK/body.txt
  local path="$1" cookie="${2:--}"
  local args=(-s -o "$WORK/body.txt" -w "$CURL_STATUS_FORMAT")
  if [[ "$cookie" != '-' ]]; then
    args+=(-H "cookie: ${cookie}")
  fi
  curl "${args[@]}" "http://127.0.0.1:${API_PORT}${path}" || true
  return 0
}

compose_stub_expect() { # path cookie status needle
  local path="$1" cookie="$2" expected="$3" needle="${4:-}" status
  status="$(compose_stub_get "$path" "$cookie")"
  if [[ "$status" != "$expected" ]]; then
    compose_fail "stub GET ${path} (${cookie}) answered HTTP ${status}, expected ${expected}"
  fi
  if [[ -n "$needle" ]]; then
    compose_body_has "$needle" "stub GET ${path} (${cookie})"
  fi
  return 0
}

compose_stub_checks() {
  local not_found_body
  compose_stub_expect /api/v1/auth/me "$CM_U1" 200 '"userId":"u1"'
  compose_body_has '"email":"u1@fixture.test"' 'stub identity u1'
  compose_body_has '"orgId":"o-u1"' 'stub identity u1'
  compose_stub_expect /api/v1/auth/me "$CM_U2" 200 '"userId":"u2"'
  compose_body_has '"orgId":"o-u2"' 'stub identity u2'
  compose_stub_expect /api/v1/auth/me "$CM_AUTHED" 200 '"userId":"u-fixture"'
  compose_body_has '"orgId":"o-fixture"' 'stub identity ok (unchanged)'
  compose_stub_expect /api/v1/auth/me session=u3 401
  compose_stub_expect /api/v1/auth/me - 401
  compose_stub_expect /api/v1/projects/p-u1 "$CM_U1" 200 '"name":"U1 Secret"'
  compose_stub_expect /api/v1/projects/p-missing "$CM_U1" 404
  not_found_body="$(cat "$WORK/body.txt")"
  compose_stub_expect /api/v1/projects/p-u2 "$CM_U1" 404
  if [[ "$(cat "$WORK/body.txt")" != "$not_found_body" ]]; then
    compose_fail "the stub's denial for another org's project differs from its answer for an unknown id (existence leak)"
  fi
  compose_stub_expect /api/v1/projects/p-u2 - 401
  fixture_stub reset > /dev/null
  log 'OK: the API stub serves per-session identities (u1, u2, ok unchanged, 401 otherwise) and org-owned projects without an existence leak'
  return 0
}

# Story 69.1: a contribution at a REGION point, opted in with `hostRoutes`, behaves like a standard
# point's: it runs as the caller (SSR HTML and __data.json carry only the caller's own marker over
# interleaved requests), never runs for an anonymous request, for a foreign project id (PV's own
# notFound skips contribution loads) or for PV's own failure, and runs once for an own project.
compose_fire_region_isolation() { # port suffix dir
  local port="$1" suffix="$2" dir="$3" round pid user
  local pids=()
  rm -rf "$dir"
  mkdir -p "$dir"
  for round in $(seq 1 "$ISOLATION_ROUNDS"); do
    for user in u1 u2; do
      curl -s -o "${dir}/${user}-${round}.body" -H "cookie: session=${user}" "http://127.0.0.1:${port}/projects/p-${user}${suffix}" &
      pids+=($!)
    done
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || compose_fail "a region isolation request (GET /projects/p-<user>${suffix}) did not complete"
  done
  return 0
}

compose_region_checks() {
  local port="$1" dir="$WORK/region" status
  fixture_stub reset > /dev/null
  compose_fire_region_isolation "$port" '' "$dir/html"
  compose_assert_isolation "$dir/html" 'region isolation (SSR HTML)' region
  compose_fire_region_isolation "$port" /__data.json "$dir/data"
  compose_assert_isolation "$dir/data" 'region isolation (__data.json)' region
  fixture_expect_count inject-load-region $((ISOLATION_ROUNDS * 4))
  fixture_stub reset > /dev/null
  compose_expect_redirect "$port" GET /projects/p-u1 "$CM_ANON" 303 /login
  compose_expect_data_redirect "$port" /projects/p-u1/__data.json "$CM_ANON" /login
  status="$(compose_request "$port" GET /projects/p-u2 "$CM_U1")"
  if [[ "$status" -ge 500 ]]; then
    compose_fail "GET /projects/p-u2 as u1 (another org) answered HTTP ${status}, expected PV's not-found page"
  fi
  compose_body_lacks 'region:u1' 'foreign project id'
  status="$(compose_request "$port" GET /projects/p-boom "$CM_U1")"
  if [[ "$status" != '500' ]]; then
    compose_fail "GET /projects/p-boom answered HTTP ${status}, expected 500 from PV's own load"
  fi
  fixture_expect_count inject-load-region 0
  compose_expect_ok "$port" GET /projects/p-u1 "$CM_U1" 'region:u1'
  fixture_expect_count inject-load-region 1
  log 'OK: a region point fill ran as the caller (SSR HTML and __data.json, interleaved), never for an anonymous request, a foreign id or a failing PV load (counter 0), and once for an own project'
  return 0
}

compose_session_injection_checks() {
  local port="$1"
  compose_stub_checks
  compose_isolation_checks "$port"
  compose_region_checks "$port"
  compose_anonymous_counter_checks "$port"
  compose_cross_tenant_checks "$port"
  compose_chunk_checks
  compose_silent_failure_selftest "$port"
  compose_browser_checks "$port"
  return 0
}

compose_http_checks() {
  local port="$1"
  if [[ "$VARIANT" == 'compose-mock-pack' ]]; then
    compose_mock_pack_checks "$port"
    return 0
  fi
  if [[ "$VARIANT" == 'compose-full-override' ]]; then
    compose_full_override_checks "$port"
    return 0
  fi
  compose_hooks_checks "$port"
  compose_injection_checks "$port"
  compose_session_injection_checks "$port"
  compose_nav_checks "$port"
  compose_expect "$port" /login 200 'Use your Acme account to continue.'
  compose_expect "$port" /billing 200 'Acme plan: pro'
  compose_expect "$port" /billing 200 'data-testid="health-tile"'
  compose_expect "$port" /billing/export 200 '"exported":true'
  compose_expect "$port" /recovery 200 'Acme recovery'
  compose_expect "$port" /status/abc 404 ''
  # Story 68.5 AC-12 (M4): PV's own (auth) layout and AppShell import PV's Footer and ShellAccount;
  # both resolve to CM's replacements, and PV's original output is still inside the wrap.
  compose_expect "$port" /login 200 'Acme footer'
  compose_expect "$port" /m4 200 'Acme footer'
  compose_expect "$port" /m4 200 'Acme health: ok'
  compose_expect "$port" /m4 200 'Role: owner'
  compose_expect "$port" /m4 200 'Org: Acme Inc (acme-server)'
  compose_expect "$port" /m4 200 '/api/v1/org/audit/exports/job-1/download?via=acme'
  log "OK: /login, /billing, /billing/export, /recovery, /m4 served; the removed /status route is 404"
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
  # Story 68.7 AC-13: an edit of nav.ts reaches the next SSR response through virtual:pv-nav
  # (a re-export of the materialized file, so Vite's module graph follows it; no restart).
  log 'dev: edit the nav delta'
  if ! compose_wait_for "$port" /m4 'CM Account Billing' 30; then
    echo "fixture: GET /m4 answered HTTP $(compose_get "$port" /m4); body head:" >&2
    head -c 3000 "$WORK/body.txt" >&2
    cat "$WORK/dev.err" "$WORK/dev.out" >&2
    return 1
  fi
  sed -i 's/CM Account Billing/CM Account Invoices/' "$PACK/nav.ts"
  started="$(date +%s)"
  if ! compose_wait_for "$port" /m4 'CM Account Invoices' 90; then
    cat "$WORK/dev.err" >&2
    return 1
  fi
  log "OK: dev mode applied an edit of nav.ts ($(($(date +%s) - started)) s)"
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

# shellcheck source=compose-mock-pack.sh
source "$FIXTURE_DIR/compose-mock-pack.sh"
