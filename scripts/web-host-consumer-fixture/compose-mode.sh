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
#   compose-dev        the Vite dev plugin mirrors pack edits, additions and deletions over HTTP
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
    *) ;;
  esac
  readonly PACK
  # The pack overrides PV's recovery page, so PV's own test of that page no longer applies to the
  # composed tree. Story 68-9 turns this into the lock's `excludedPvTests`; until then the fixture
  # leaves that one test directory out of its run.
  # Story 68-6: the mini pack contributes hooks and a header-policy delta, so PV's own tests that pin
  # PV's exact hooks behaviour (the whole-response oracle, the no-contribution hooks exports, the
  # direct handle tests) describe PV, not this composed app. Same 68-9 hand-off as above.
  VITEST_ARGS=(--exclude '**/node_modules/**' --exclude 'src/routes/*/recovery/**'
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

# One request recording its status (echoed), headers ($WORK/headers.txt) and body ($WORK/body.txt).
compose_request() {
  local port="$1" method="$2" path="$3"
  curl -s -o "$WORK/body.txt" -D "$WORK/headers.txt" -X "$method" \
    -H "origin: http://127.0.0.1:${port}" -H 'content-type: application/x-www-form-urlencoded' \
    -w '%{http_code}' "http://127.0.0.1:${port}${path}" || true
  return 0
}

compose_expect_redirect() { # port method path status location
  local port="$1" method="$2" path="$3" expected="$4" location="$5"
  local status
  status="$(compose_request "$port" "$method" "$path")"
  if [[ "$status" != "$expected" ]] || ! grep -qiE "^location: ${location}[[:space:]]*$" "$WORK/headers.txt"; then
    echo "fixture: $method $path answered HTTP $status, expected $expected to $location" >&2
    cat "$WORK/headers.txt" >&2
    exit 1
  fi
  return 0
}

compose_expect_header() { # port path header value
  local port="$1" path="$2" header="$3" value="$4"
  compose_request "$port" GET "$path" > /dev/null
  if ! grep -qi "^${header}: ${value}" "$WORK/headers.txt"; then
    echo "fixture: GET $path lacks ${header}: ${value}" >&2
    cat "$WORK/headers.txt" >&2
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

# Story 68-6 AC-6/AC-9/Q5: derived protection for CM (app) routes, the reroute bypass closed, the
# CM header-policy delta on real responses, the CM before handle on every response.
compose_hooks_checks() {
  local port="$1"
  compose_expect_redirect "$port" GET /cm-area 303 /login
  if [[ "$(compose_request "$port" GET /cm-area/__data.json)" != '200' ]] ||
    ! grep -q '"type":"redirect","location":"/login"' "$WORK/body.txt"; then
    echo 'fixture: the /cm-area data request was not redirected to /login' >&2
    exit 1
  fi
  compose_expect_redirect "$port" POST '/cm-area?/save' 303 /login
  compose_expect_redirect "$port" GET /cm-area/export 303 /login
  compose_expect_redirect "$port" GET /go/settings 303 /login
  compose_expect_header "$port" /cm-area x-cm-before PV_HOOKS_SERVER_MARKER_6c1f0a
  compose_expect_header "$port" /billing x-cm-policy on
  compose_expect_header "$port" /billing x-frame-options DENY
  compose_expect_header "$port" /login x-cm-policy on
  log 'OK: CM (app) page, data request, action and endpoint, and a rerouted URL redirect anonymous users; CM policy and handle applied'
  return 0
}

compose_http_checks() {
  local port="$1"
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
  log 'dev: delete an override (the PV page must come back)'
  rm "$PACK/src/routes/(auth)/recovery/+page.svelte"
  local _
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
