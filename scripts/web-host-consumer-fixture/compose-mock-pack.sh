#!/usr/bin/env bash
# Story 68.10 AC-2.1: the compose stage of the mock UI pack mechanism e2e. Sourced by compose-mode.sh
# for the `compose-mock-pack` variant: the mock UI pack (fixtures/mock-ui-pack/ui-pack, staged by the
# test as COMPOSITION_KIT_FIXTURES/mock-ui-pack) is composed onto the PACKED web-host, then run.sh's
# normal pipeline runs (svelte-check, the shipped unit tests, vite build, boot) and the checks below
# assert M1, M2, M3 (public points), M4 and M6 over HTTP against the API stub, with `pv-compose
# --check` and `pv-verify --only guards` (including the monolithic-region guard and its CM-exemption
# proof). The real-API / Docker part of the job is separate (docker-compose.mock-ui-pack.yml).
#
# Uses run.sh's WORK, APP, INSTALLED, PACK, NODE_BIN, clean_env, log and compose-mode.sh's helpers.

readonly MOCK_SESSION='session=ok'
readonly MOCK_COMPOSE_BIN='node_modules/@project-vault/composition-kit/dist/cli.js'
readonly MOCK_VERIFY_BIN='node_modules/@project-vault/composition-kit/dist/verify-cli.js'

# A monolithic region: plain HTML and a point, neither a component nor containing one.
readonly MOCK_MONOLITHIC_REGION=$'<!-- @region mock-monolithic -->\n<div>plain</div>\n'

mock_fail() {
  echo "fixture: $*" >&2
  exit 1
}

# Story 68-26: svelte-check over the composed tree through the kit's supported configuration
# (`pv-verify --only tsconfig`), which excludes exactly the lock's `excludedPvTests`. This pack overrides
# the dashboard page AND its server load with a different contract (the CM 16-3 shape), so PV's tests of
# that load are typed against a contract they do not expect. Three runs prove the mechanism:
#   1. control: the app's plain tsconfig.json is RED on at least one excluded test (the defect is real)
#   2. the generated tsconfig is green (replacement test, retained PV tests, production sources checked)
#   3. one type error planted in each retained category is red, and the output names every planted file
mock_pack_excluded_list() { # prints the lock's excludedPvTests, one per line
  clean_env "$NODE_BIN" -e '
    const lock = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write(lock.excludedPvTests.join("\n") + "\n")
  ' "$APP/composition.lock.json"
  return 0
}

mock_pack_svelte_check_run() { # tsconfig -> output in $WORK/svelte-check.out; exit status returned
  local tsconfig="$1" status=0
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/svelte-check/bin/svelte-check \
    --tsconfig "$tsconfig" --fail-on-warnings) > "$WORK/svelte-check.out" 2>&1 || status=$?
  return "$status"
}

mock_pack_svelte_check() {
  local excluded status=0 test_file control_names_excluded=0
  excluded="$(mock_pack_excluded_list)"
  if ! grep -qF 'dashboard-page.server.test.ts' <<< "$excluded"; then
    mock_fail "the dashboard load test is not in excludedPvTests: $excluded"
  fi
  log "svelte-check control: the app's own tsconfig.json over the displaced PV tests must be red"
  mock_pack_svelte_check_run ./tsconfig.json || status=$?
  if [[ "$status" == '0' ]]; then
    mock_fail 'svelte-check passed with no exclusion: the mock pack no longer displaces a tested contract'
  fi
  while IFS= read -r test_file; do
    if grep -qF "$test_file" "$WORK/svelte-check.out"; then
      log "OK: the control is red on the displaced test $test_file"
      control_names_excluded=1
      break
    fi
  done <<< "$excluded"
  if [[ "$control_names_excluded" != '1' ]]; then
    cat "$WORK/svelte-check.out" >&2
    mock_fail 'the control svelte-check failed, but not on a PV test the lock excludes'
  fi
  log 'pv-verify --only tsconfig, then svelte-check --fail-on-warnings over the generated tsconfig'
  compose_write_check_tsconfig || { cat "$WORK/tsconfig.out" >&2; mock_fail 'pv-verify --only tsconfig failed'; }
  mock_pack_assert_tsconfig_exclusions "$excluded"
  mock_pack_svelte_check_run ./tsconfig.composed.json || {
    cat "$WORK/svelte-check.out" >&2
    mock_fail 'svelte-check is red over the generated tsconfig'
  }
  mock_pack_planted_type_errors
  return 0
}

# AC-1: the generated exclude is exactly the app's own base excludes (derived here from SvelteKit's
# generated tsconfig, not from the kit) followed by the lock's list: same entries, same order, no glob,
# no extra path, and the whole list is non-empty.
mock_pack_assert_tsconfig_exclusions() { # excluded
  clean_env "$NODE_BIN" -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const [generatedFile, lockFile, appDir] = process.argv.slice(1)
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
    const locked = read(lockFile).excludedPvTests
    const exclude = read(generatedFile).exclude
    const own = read(path.join(appDir, "tsconfig.json")).exclude
    const rebased = (read(path.join(appDir, ".svelte-kit/tsconfig.json")).exclude ?? []).map((entry) =>
      path.isAbsolute(entry) ? entry : path.posix.normalize(path.posix.join(".svelte-kit", entry)))
    const base = Array.isArray(own) ? own : rebased
    const fail = (message, detail) => { console.error(message, detail); process.exit(1) }
    if (locked.length === 0) fail("the lock excludes no PV test", locked)
    if (base.length === 0) fail("the expected base excludes are empty", base)
    const tail = exclude.slice(base.length)
    if (JSON.stringify(exclude.slice(0, base.length)) !== JSON.stringify(base)) {
      fail("the generated base excludes differ from the app own excludes", { exclude, base })
    }
    if (JSON.stringify(tail) !== JSON.stringify(locked)) {
      fail("the generated trailing entries differ from the lock excludedPvTests", { tail, locked })
    }
    if (tail.some((entry) => /[*?]/.test(entry))) fail("a glob was added", tail)
  ' "$APP/tsconfig.composed.json" "$APP/composition.lock.json" "$APP" ||
    mock_fail 'the generated tsconfig does not exclude exactly the app excludes plus the lock excludedPvTests'
  log 'OK: the generated tsconfig excludes exactly the app excludes plus the lock excludedPvTests (no glob, no extra path)'
  return 0
}

readonly MOCK_RETAINED_PV_TEST='src/lib/utils/reset-on.test.ts'
readonly MOCK_RETAINED_PV_SOURCE='src/lib/utils/format-bytes.ts'
readonly MOCK_CM_TEST='src/routes/(app)/dashboard/dashboard-replacement-contract.test.ts'
readonly MOCK_TYPES_PAGE='src/routes/billing/+page.svelte'
readonly MOCK_PLANTED_ERROR=$'\nexport const plantedTypeError: number = \'not a number\'\n'

# AC-3: a type error in each retained category is red under the generated tsconfig. Each file is backed up
# and restored; the planted files must each be named by svelte-check, so none is silently excluded.
mock_pack_planted_type_errors() {
  local file status=0 backup="$WORK/planted-backup"
  local -a planted=("$MOCK_RETAINED_PV_TEST" "$MOCK_RETAINED_PV_SOURCE" "$MOCK_CM_TEST")
  if grep -qxF -e "$MOCK_RETAINED_PV_TEST" -e "$MOCK_RETAINED_PV_SOURCE" < <(mock_pack_excluded_list); then
    mock_fail 'a file the retained-category mutation plants into is in excludedPvTests'
  fi
  rm -rf "$backup"
  mkdir -p "$backup"
  for file in "${planted[@]}" "$MOCK_TYPES_PAGE"; do
    [[ -f "$APP/$file" ]] || mock_fail "retained-category mutation: $file does not exist in the composed app"
    mkdir -p "$backup/$(dirname "$file")"
    cp "$APP/$file" "$backup/$file"
  done
  for file in "${planted[@]}"; do
    printf '%s' "$MOCK_PLANTED_ERROR" >> "$APP/$file"
  done
  # Generated route types: the page reads a field its load does not return (./$types must still apply).
  sed -i 's/data\.plan/data.nope/' "$APP/$MOCK_TYPES_PAGE"
  mock_pack_svelte_check_run ./tsconfig.composed.json || status=$?
  for file in "${planted[@]}" "$MOCK_TYPES_PAGE"; do
    cp "$backup/$file" "$APP/$file"
  done
  if [[ "$status" == '0' ]]; then
    mock_fail 'svelte-check stayed green with a type error in every retained category'
  fi
  for file in "${planted[@]}" "$MOCK_TYPES_PAGE"; do
    if ! grep -qF "$file" "$WORK/svelte-check.out"; then
      cat "$WORK/svelte-check.out" >&2
      mock_fail "mutation: svelte-check did not report the planted error in $file (is it excluded?)"
    fi
  done
  log 'OK: a type error in a retained PV test, a production source, a CM replacement test and a generated route type is red'
  mock_pack_svelte_check_run ./tsconfig.composed.json || mock_fail 'svelte-check is red after the planted files were restored'
  return 0
}

# pv-compose --check: the lock the composition just wrote is current (it writes nothing).
mock_pack_compose_check() {
  log 'pv-compose --check'
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" "$MOCK_COMPOSE_BIN" \
    --pack "$PACK" --module-pack "$APP" --check) || mock_fail 'pv-compose --check failed on a fresh composition'
  mock_pack_stale_hash_negative
  return 0
}

# M4 failure row: a replacement whose `hostSha256` is stale fails the composition with exit 1 and names
# the file (a PV edit never needs a hash bump, because the manifest computes hashes when it loads; this
# stale value exists only here, in a copy, on purpose). The composition itself catches it (drift against
# the declared hash); the original composition is restored afterwards.
mock_pack_stale_hash_negative() {
  mock_pack_stale_hash_one 'src/lib/components/shell/Footer.svelte' 'Footer.svelte'
  mock_pack_stale_hash_one 'src/lib/components/settings/SettingsHomeHeader.svelte' 'SettingsHomeHeader.svelte'
  return 0
}

mock_pack_stale_hash_one() {
  local host_path="$1" name="$2"
  local copy="$WORK/pack-stale" status=0
  rm -rf "$copy"
  cp -r "$PACK" "$copy"
  ln -sfn "$APP/node_modules" "$copy/node_modules"
  sed -i "s#hostSha256: sha('$host_path')#hostSha256: '0'.repeat(64)#" \
    "$copy/pv-ui.manifest.ts"
  if ! grep -q "'0'.repeat(64)" "$copy/pv-ui.manifest.ts"; then
    mock_fail 'the stale-hash mutation did not apply to the manifest copy'
  fi
  # With a committed lock the lock holds the accepted hash and the declaration is not consulted, so the
  # negative composes from a state with no lock (a first composition), then the real one is restored.
  rm -f "$APP/composition.lock.json"
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" "$MOCK_COMPOSE_BIN" \
    --pack "$copy" --module-pack "$APP") > "$WORK/mock-stale.out" 2>&1 || status=$?
  if [[ "$status" != '1' ]] || ! grep -q "$name" "$WORK/mock-stale.out"; then
    cat "$WORK/mock-stale.out" >&2
    mock_fail "a stale replacement hash did not fail the composition naming $name (exit $status)"
  fi
  log "OK: a stale replacement hash fails the composition (exit 1) and names $name"
  mock_compose_pack "$PACK"
  return 0
}

mock_verify() { # args... -> exit status; output in $WORK/mock-verify.out
  local status=0
  (cd "$APP" && clean_env "$NODE_BIN" "$MOCK_VERIFY_BIN" --app "$APP" --host "$INSTALLED" "$@") \
    > "$WORK/mock-verify.out" 2>&1 || status=$?
  return "$status"
}

# pv-verify's guards over the composed tree: green, red for a monolithic region in a PV-originated
# file, and green again for the SAME markup in a CM-originated file (exempt by lock provenance).
mock_pack_verify_guards() {
  log 'pv-verify --only guards (clean)'
  mock_verify --only guards || {
    cat "$WORK/mock-verify.out" >&2
    mock_fail 'pv-verify --only guards failed over the clean mock pack'
  }
  if ! grep -q 'monolithic-region' "$WORK/mock-verify.out"; then
    cat "$WORK/mock-verify.out" >&2
    mock_fail 'pv-verify did not run the monolithic-region guard'
  fi
  local target="$APP/src/lib/components/shell/AuthBrandHeader.svelte" backup="$WORK/AuthBrandHeader.svelte.bak"
  cp "$target" "$backup"
  printf '%s\n%s' "$MOCK_MONOLITHIC_REGION" "$(cat "$backup")" > "$target"
  local status=0
  mock_verify --only guards || status=$?
  cp "$backup" "$target"
  if [[ "$status" != '1' ]] || ! grep -qF 'is a monolithic region' "$WORK/mock-verify.out"; then
    cat "$WORK/mock-verify.out" >&2
    mock_fail "a monolithic region in a PV-originated file was not red (exit $status)"
  fi
  log 'OK: a monolithic region in a PV-originated file is red'
  # The SAME markup in a file the pack adds (recorded in the lock as CM's) is exempt: compose a copy
  # of the pack with such a file, expect green, then restore the original composition.
  local copy="$WORK/pack-region"
  rm -rf "$copy"
  cp -r "$PACK" "$copy"
  ln -sfn "$APP/node_modules" "$copy/node_modules"
  mkdir -p "$copy/src/lib"
  printf '%s' "$MOCK_MONOLITHIC_REGION" > "$copy/src/lib/MockRegion.svelte"
  mock_compose_pack "$copy"
  mock_verify --only guards || {
    cat "$WORK/mock-verify.out" >&2
    mock_fail 'a monolithic region in a CM-originated file was not exempt'
  }
  log 'OK: the same markup in a CM-originated file is exempt (lock provenance)'
  mock_compose_pack "$PACK"
  mock_verify --only guards || mock_fail 'pv-verify --only guards is not green after restoring the pack'
  return 0
}

mock_compose_pack() { # pack
  local pack="$1"
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" "$MOCK_COMPOSE_BIN" \
    --pack "$pack" --module-pack "$APP") > "$WORK/mock-compose.out" 2>&1 || {
    cat "$WORK/mock-compose.out" >&2
    mock_fail "pv-compose --pack $(basename "$pack") failed"
  }
  return 0
}

mock_expect_in_css() { # needle
  local needle="$1"
  if ! cat "$APP"/build/client/_app/immutable/assets/*.css | grep -q -- "$needle"; then
    mock_fail "the built CSS lacks $needle"
  fi
  return 0
}

mock_expect_no_stack() { # label
  local label="$1"
  if grep -Eq '(^|[^a-z])at [A-Za-z_.<>]+ \(|node_modules|\.ts:[0-9]+' "$WORK/body.txt"; then
    mock_fail "$label leaked a stack trace"
  fi
  return 0
}

mock_check_m1() {
  local port="$1"
  compose_expect_redirect "$port" GET /dashboard - 303 /login
  compose_expect_ok "$port" GET /dashboard "$MOCK_SESSION" 'mock-ui-pack:m1-dashboard-load'
  compose_expect_ok "$port" GET /dashboard "$MOCK_SESSION" 'u-fixture'
  compose_expect_redirect "$port" GET '/dashboard?mock-redirect=1' "$MOCK_SESSION" 303 /settings
  local status
  status="$(compose_request "$port" POST '/dashboard?/note' "$MOCK_SESSION" "http://127.0.0.1:$port" 'note=hello')"
  if [[ "$status" != '200' ]] || ! grep -qF 'mock-ui-pack:m1-dashboard-note:hello' "$WORK/body.txt"; then
    mock_fail "the dashboard note action answered HTTP $status"
  fi
  compose_expect "$port" /recovery 200 'mock-ui-pack:m1-recovery-load'
  status="$(compose_request "$port" POST '/recovery?/ping' - "http://127.0.0.1:$port" 'word=ping')"
  if [[ "$status" != '200' ]] || ! grep -qF 'mock-ui-pack:m1-recovery-pong:ping' "$WORK/body.txt"; then
    mock_fail "the recovery ping action answered HTTP $status"
  fi
  compose_expect "$port" /login 200 'mock-ui-pack:m1-auth-layout'
  compose_expect "$port" /login 200 'name="mock-ui-pack" content="m1-app-html"'
  compose_expect_header "$port" /login x-mock-ui-pack-handle m1-hooks-handle
  compose_expect_header "$port" /login x-mock-ui-pack-policy m1-hooks-policy
  # The forced 404 renders the pack's error page without a stack.
  compose_expect "$port" /nonexistent-mock-route 404 'mock-ui-pack:m1-error'
  mock_expect_no_stack 'the 404 error page'
  # Static: the pack's favicon bytes, not PV's, and a new static file.
  curl -s -o "$WORK/favicon.png" "http://127.0.0.1:${port}/favicon.png"
  cmp -s "$WORK/favicon.png" "$PACK/static/favicon.png" || mock_fail '/favicon.png is not the pack favicon'
  if cmp -s "$WORK/favicon.png" "$INSTALLED/static/favicon.png"; then
    mock_fail '/favicon.png is still PV favicon'
  fi
  compose_expect "$port" /mock-ui-pack.txt 200 'mock-ui-pack:m1-static-file'
  # Removal is exactly what was declared: /recovery/abc is gone, other PV routes are not.
  compose_expect "$port" /recovery/abc 404 ''
  compose_expect "$port" /status/abc 200 ''
  compose_expect "$port" /register 200 ''
  log 'OK: M1 overrides (load, actions, 303, layout, error, hooks, app.html, static, removal)'
  return 0
}

mock_check_m2() {
  local port="$1" status
  compose_expect "$port" /billing 200 'mock-ui-pack:m2-billing-plan'
  compose_expect "$port" /billing/deep/level 200 'mock-ui-pack:m2-billing-deep'
  compose_expect "$port" /billing/data 200 'mock-ui-pack:m2-billing-data'
  status="$(curl -s -o "$WORK/body.txt" -w "$CURL_STATUS_FORMAT" -X POST \
    -H "origin: http://127.0.0.1:${port}" -H 'content-type: application/json' \
    --data '{"echo":"x"}' "http://127.0.0.1:${port}/billing/data")"
  if [[ "$status" != '200' ]] || ! grep -qF 'mock-ui-pack:m2-billing-post' "$WORK/body.txt"; then
    mock_fail "POST /billing/data answered HTTP $status"
  fi
  status="$(curl -s -o /dev/null -w "$CURL_STATUS_FORMAT" -X PUT \
    -H "origin: http://127.0.0.1:${port}" "http://127.0.0.1:${port}/billing/data")"
  [[ "$status" == '405' ]] || mock_fail "PUT /billing/data answered HTTP $status, expected 405"
  # (app) route: protected by derivation, in every spelling of the path.
  compose_expect_redirect "$port" GET /cm-area - 303 /login
  # A trailing slash is normalised by SvelteKit (308) and the normalised path is protected too.
  compose_expect_redirect "$port" GET '/cm-area/' - 308 /cm-area
  compose_expect_redirect "$port" GET '/%63m-area' - 303 /login
  compose_expect_data_redirect "$port" /cm-area/__data.json - /login
  compose_expect_ok "$port" GET /cm-area "$MOCK_SESSION" 'a signed-in user'
  # Outside (app) but declared protected; under (app) but declared public.
  compose_expect_redirect "$port" GET /protected-cm - 303 /login
  compose_expect_ok "$port" GET /protected-cm "$MOCK_SESSION" 'mock-ui-pack:m2-protected-cm'
  compose_expect "$port" /cm-area/public-callback 200 'mock-ui-pack:m2-public-callback'
  log 'OK: M2 routes (page, endpoint, 405, depth, protected by derivation/add, public by remove)'
  return 0
}

mock_check_m4_m6() {
  local port="$1"
  # M4: PV's own (auth) layout import of Footer resolves to the replacement; the wrapped account
  # and `$lib/server` / `$lib/api` wraps show on authenticated PV pages.
  compose_expect "$port" /login 200 'mock-ui-pack:m4-footer'
  compose_expect_ok "$port" GET /cm-area "$MOCK_SESSION" 'mock-ui-pack:m4-account-wrap'
  compose_expect_ok "$port" GET /cm-area "$MOCK_SESSION" 'mock-ui-pack:m4-footer'
  # Story 69.5: the extracted settings home header is replaced (wrapped) on /settings.
  compose_expect_ok "$port" GET /settings "$MOCK_SESSION" 'mock-ui-pack:m4-settings-home'
  # M6: tokens, the pack's own style and a utility used only by the pack reach the built CSS.
  mock_expect_in_css '0f766e'
  mock_expect_in_css '6b4423'
  mock_expect_in_css 'mock-ui-pack-unknown-token'
  mock_expect_in_css 'text-slate-500'
  compose_expect "$port" /login 200 'mock-ui-pack:m6-message'
  log 'OK: M4 replacements and M6 tokens, own styles and @source utilities'
  return 0
}

mock_check_m3() {
  local port="$1"
  # A public native page: the injected tile renders with its server load data, before PV's own
  # markup stays intact (PV's sign-in form is still served beside it).
  compose_expect "$port" /login 200 'mock-ui-pack:m3-login-tile'
  compose_expect "$port" /login 200 'name="mock-ui-pack-injected" content="m3-shell-head"'
  compose_expect "$port" /login 200 '<form'
  log 'OK: M3 injection into a native public page (component, load, shell head) beside PV markup'
  # Story 69.2 AC-8: the pack does not override the credential page, so the composer records its three
  # fills as plain contributions and prints no "this pack overrides <file>" note for a credential point
  # (the negative of the M1 note a point held by an overridden page gets).
  local point
  for point in credential.detail.actions credential.detail.shares credential.detail.metadata; do
    grep -qF "\"$point\"" "$APP/composition.lock.json" || mock_fail "the lock does not record the credential point $point"
  done
  if grep -qF 'injections.credential.detail.' "$APP/composition.lock.json"; then
    mock_fail 'the lock carries a compose note for a credential point (the pack does not override that page)'
  fi
  log 'OK: the credential region fills are recorded in the lock with no held-by-overridden-page note'
  return 0
}

# AC-2.2: when MOCK_UI_PACK_CONTEXT_OUT names a directory, export the composed app there as a Docker
# build context: the composed sources and config, the three tarballs under ./tarballs and a
# package.json whose `file:` specs point at them relatively. No node_modules, no build output, no
# monorepo path. The orchestrator adds the Dockerfile and .dockerignore.
mock_pack_export_context() {
  local out="${MOCK_UI_PACK_CONTEXT_OUT:-}" item
  [[ -n "$out" ]] || return 0
  log "exporting the composed app as a build context: $out"
  rm -rf "$out"
  mkdir -p "$out/tarballs"
  for item in src static messages project.inlang inlang-plugins vendor svelte.config.js vite.config.ts \
    tsconfig.json composition.lock.json .pv-compose; do
    cp -r "$APP/$item" "$out/"
  done
  # pv-verify's scratch directory is not a composer output.
  rm -rf "$out/.pv-compose/guard-run"
  cp "$TARBALL" "$COMPOSITION_KIT_TARBALL" "$out/tarballs/"
  if [[ -n "$EXTENSION_API_TARBALL" ]]; then
    cp "$EXTENSION_API_TARBALL" "$out/tarballs/"
  fi
  clean_env "$NODE_BIN" -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const [source, out] = process.argv.slice(1)
    const pkg = JSON.parse(fs.readFileSync(source, "utf8"))
    for (const section of ["dependencies", "devDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
        if (String(spec).startsWith("file:")) {
          pkg[section][name] = "file:./tarballs/" + path.basename(String(spec).slice(5))
        }
      }
    }
    fs.writeFileSync(out, JSON.stringify(pkg, null, 2))
  ' "$APP/package.json" "$out/package.json"
  log 'OK: composed app exported as a build context'
  return 0
}

# Story 68.23 AC-2: when MOCK_UI_PACK_CLASSIFICATIONS_OUT names a file, extract the composed pack's
# route classifications there with pv-verify (never hand-written), so the shipped route audit
# (`node dist/scripts/runtime-route-audit.js --classifications <file>`, run in the API image by the
# orchestrator) reads exactly what a consumer's pipeline would: 68-16's extraction chained to 68-14's
# parser.
mock_pack_export_classifications() {
  local out="${MOCK_UI_PACK_CLASSIFICATIONS_OUT:-}"
  [[ -n "$out" ]] || return 0
  log "extracting the route classifications: $out"
  mock_verify --only classifications --out "$out" || {
    cat "$WORK/mock-verify.out" >&2
    mock_fail 'pv-verify --only classifications failed over the mock pack'
  }
  [[ -s "$out" ]] || mock_fail 'pv-verify --only classifications wrote no file'
  log 'OK: route classifications extracted'
  return 0
}

# M5 failure row: an id web-host does not have is RECORDED and REPORTED, never refused: the lock lists
# every id the pack's nav delta declares and references, and the compose output notes the vanished one.
mock_check_m5() {
  local lock="$APP/composition.lock.json" id
  for id in mock.billing mock.tools.reports.daily mock.crumb.deep mock.account.more.one; do
    grep -qF "\"$id\"" "$lock" || mock_fail "the lock does not record the declared nav id $id"
  done
  for id in primary.secrets primary.health primary.mock-not-a-pv-item breadcrumbs.platform; do
    grep -qF "\"$id\"" "$lock" || mock_fail "the lock does not record the referenced nav id $id"
  done
  # the notes are recorded in the lock (the composition succeeded, so nothing was refused)
  for needle in 'nav references: ' \
    'nav id \"primary.mock-not-a-pv-item\" vanished from web-host; it is only hidden or removed'; do
    grep -qF -- "$needle" "$lock" || mock_fail "the lock notes lack: $needle"
  done
  log 'OK: M5 nav ids recorded in the lock; an unknown hidden id is noted, not refused'
  return 0
}

# AC-7.1: the lock records the module pack's two security changes (one loosened on purpose, one
# tightened) and every other override as `replaceSecurity: false`: recorded, never refused.
mock_check_m7_lock() {
  clean_env "$NODE_BIN" -e '
    const lock = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const rows = lock.apiRouteOverrides
    const find = (method, url) => rows.find((row) => row.method === method && row.url === url)
    const fail = (message) => { console.error("fixture: " + message); process.exit(1) }
    if (!Array.isArray(rows) || rows.length < 4) fail("the lock lacks apiRouteOverrides: " + JSON.stringify(rows))
    if (find("POST", "/api/v1/auth/cli-login")?.replaceSecurity !== true) fail("the loosened route is not recorded as replaceSecurity")
    if (find("GET", "/api/v1/capabilities")?.replaceSecurity !== true) fail("the tightened route is not recorded as replaceSecurity")
    const plain = find("GET", "/api/v1/users/me")
    if (plain === undefined || plain.mode !== "replace" || plain.replaceSecurity) fail("the plain replace is missing or marked replaceSecurity")
  ' "$APP/composition.lock.json" || mock_fail 'the lock does not record the module pack route overrides'
  log 'OK: the lock records the loosened and tightened routes and the plain replace'
  return 0
}

compose_mock_pack_checks() {
  local port="$1"
  mock_check_m1 "$port"
  mock_check_m2 "$port"
  mock_check_m3 "$port"
  mock_check_m4_m6 "$port"
  mock_check_m5
  mock_pack_export_context
  mock_pack_export_classifications
  return 0
}
