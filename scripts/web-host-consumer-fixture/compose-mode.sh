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
    // svelte-check types the shipped tests, which import node: modules (web-host does not list it).
    pkg.devDependencies["@types/node"] = typesNode
    // svelte-check types the shipped tests, which import node: modules (web-host does not list it).
    pkg.devDependencies["@types/node"] = typesNode
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
  ' "$APP/package.json" "$COMPOSITION_KIT_TARBALL" "$COMPOSITION_KIT_SVELTE_CHECK" "$COMPOSITION_KIT_TYPES_NODE" "$COMPOSITION_KIT_TYPES_NODE" "$COMPOSITION_KIT_TYPES_NODE"
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
  VITEST_ARGS=(--exclude '**/node_modules/**' --exclude 'src/routes/*/recovery/**')
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
}

compose_assert_css() {
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
  curl -s -o "$WORK/body.txt" -w '%{http_code}' "http://127.0.0.1:$1$2" || true
}

compose_expect() { # port path status needle
  local status
  status="$(compose_get "$1" "$2")"
  if [[ "$status" != "$3" ]]; then
    echo "fixture: GET $2 answered HTTP $status, expected $3" >&2
    exit 1
  fi
  if [[ -n "${4:-}" ]] && ! grep -q -- "$4" "$WORK/body.txt"; then
    echo "fixture: GET $2 did not contain: $4" >&2
    exit 1
  fi
}

compose_http_checks() {
  local port="$1"
  compose_expect "$port" /login 200 'Use your Acme account to continue.'
  compose_expect "$port" /billing 200 'Acme plan: pro'
  compose_expect "$port" /billing 200 'data-testid="health-tile"'
  compose_expect "$port" /billing/export 200 '"exported":true'
  compose_expect "$port" /recovery 200 'Acme recovery'
  compose_expect "$port" /status/abc 404 ''
  log "OK: /login, /billing, /billing/export, /recovery served; the removed /status route is 404"
}

# Dev mode (AC-13): the plugin composes on start and mirrors pack edits, additions and deletions.
compose_wait_for() { # port path needle seconds
  local _
  for _ in $(seq 1 "$4"); do
    if [[ "$(compose_get "$1" "$2")" == '200' ]] && grep -q -- "$3" "$WORK/body.txt"; then
      return 0
    fi
    sleep 1
  done
  echo "fixture: GET $2 never contained: $3" >&2
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
