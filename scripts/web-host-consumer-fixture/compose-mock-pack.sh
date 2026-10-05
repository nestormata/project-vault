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

# svelte-check over the composed tree. PV's own shipped tests that the lock lists in
# `excludedPvTests` (their subject was overridden, so vitest skips them) are still TYPED by
# svelte-check against the overriding page's data, which no longer has PV's shape: they are ignored
# here the same way, from the lock, never from a hand-written list. (Recorded as a mechanism gap:
# the kit does not yet hand a consumer a svelte-check exclusion.)
mock_pack_svelte_check() {
  # svelte-check's own `--ignore` works only with --no-tsconfig, so the exclusion is a derived
  # tsconfig that extends the consumer's own and adds the lock's list to `exclude`.
  clean_env "$NODE_BIN" -e '
    const fs = require("node:fs")
    const [lockFile, out] = process.argv.slice(1)
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"))
    const exclude = lock.excludedPvTests.map((file) => "./" + file)
    fs.writeFileSync(out, JSON.stringify({ extends: "./tsconfig.json", exclude }, null, 2))
  ' "$APP/composition.lock.json" "$APP/tsconfig.mock-check.json"
  log "svelte-check --fail-on-warnings, excluding the lock's excludedPvTests"
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/svelte-check/bin/svelte-check \
    --tsconfig ./tsconfig.mock-check.json --fail-on-warnings)
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
  local copy="$WORK/pack-stale" status=0
  rm -rf "$copy"
  cp -r "$PACK" "$copy"
  ln -sfn "$APP/node_modules" "$copy/node_modules"
  sed -i "s#hostSha256: sha('src/lib/components/shell/Footer.svelte')#hostSha256: '0'.repeat(64)#" \
    "$copy/pv-ui.manifest.ts"
  if ! grep -q "'0'.repeat(64)" "$copy/pv-ui.manifest.ts"; then
    mock_fail 'the stale-hash mutation did not apply to the manifest copy'
  fi
  # With a committed lock the lock holds the accepted hash and the declaration is not consulted, so the
  # negative composes from a state with no lock (a first composition), then the real one is restored.
  rm -f "$APP/composition.lock.json"
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" "$MOCK_COMPOSE_BIN" \
    --pack "$copy" --module-pack "$APP") > "$WORK/mock-stale.out" 2>&1 || status=$?
  if [[ "$status" != '1' ]] || ! grep -q 'Footer.svelte' "$WORK/mock-stale.out"; then
    cat "$WORK/mock-stale.out" >&2
    mock_fail "a stale replacement hash did not fail the composition naming the file (exit $status)"
  fi
  log 'OK: a stale replacement hash fails the composition (exit 1) and names Footer.svelte'
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
  # Removal is exactly what was declared: /external-shares/<token> is gone, other PV routes are not.
  compose_expect "$port" /external-shares/abc 404 ''
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
