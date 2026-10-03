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
    compose-server-leak | compose-server-twin | compose-replace-leak | compose-replace-first-leak) echo negative-pack ;;
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
    *) ;;
  esac
  readonly PACK
  # The pack overrides PV's recovery page, so PV's own test of that page no longer applies to the
  # composed tree. Story 68.5 (`pvReplace()` is in this app's vitest plugins) makes the same true of
  # a test whose subject is a REPLACED file: it now exercises CM's replacement, which changes the
  # behaviour the test pins on purpose (the audit download URL, the org name `requireUser` returns,
  # the header markup). Story 68-9 turns both into the lock's `excludedPvTests`, keyed on the
  # replaced host file; until then the fixture leaves exactly these tests out of its run.
  VITEST_ARGS=(
    --exclude '**/node_modules/**'
    --exclude 'src/routes/*/recovery/**'
    --exclude 'src/lib/api/audit.test.ts'
    --exclude 'src/lib/server/require-platform-operator.test.ts'
    --exclude 'src/lib/components/audit/AuditExportPanel.test.ts'
    --exclude 'src/lib/components/shell/AppShell.characterization.test.ts'
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
  status="$(curl -s -o "$WORK/body.txt" -w '%{http_code}' -X POST \
    -H "Origin: http://127.0.0.1:${port}" -H 'x-sveltekit-action: true' \
    --data-urlencode 'note=hello' "http://127.0.0.1:${port}/register?/auth.register.after.share")"
  if [[ "$status" != '200' ]] || ! grep -q '"type":"success"' "$WORK/body.txt"; then
    echo "fixture: the injected action answered HTTP $status: $(cat "$WORK/body.txt")" >&2
    exit 1
  fi
  status="$(curl -s -o "$WORK/body.txt" -w '%{http_code}' -X POST \
    -H "Origin: http://127.0.0.1:${port}" -H 'x-sveltekit-action: true' \
    "http://127.0.0.1:${port}/register?/auth.register.after.nope")"
  if [[ "$status" != '404' ]]; then
    echo "fixture: an unknown injected action answered HTTP $status, expected 404" >&2
    exit 1
  fi
  log 'OK: injected markup (in order), load data, layout point, shell head and action served'
  return 0
}

compose_http_checks() {
  local port="$1"
  compose_injection_checks "$port"
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
