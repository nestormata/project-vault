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
  ln -s "$APP/node_modules" "$copy/node_modules"
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
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" "$MOCK_COMPOSE_BIN" \
    --pack "$1" --module-pack "$APP") > "$WORK/mock-compose.out" 2>&1 || {
    cat "$WORK/mock-compose.out" >&2
    mock_fail "pv-compose --pack $(basename "$1") failed"
  }
  return 0
}

mock_expect_in_css() { # needle
  if ! cat "$APP"/build/client/_app/immutable/assets/*.css | grep -q -- "$1"; then
    mock_fail "the built CSS lacks $1"
  fi
  return 0
}

mock_expect_no_stack() { # label
  if grep -Eq '(^|[^a-z])at [A-Za-z_.<>]+ \(|node_modules|\.ts:[0-9]+' "$WORK/body.txt"; then
    mock_fail "$1 leaked a stack trace"
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
  # Removal is exactly what was declared: /status/<token> is gone, other PV routes are not.
  compose_expect "$port" /status/abc 404 ''
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
  return 0
}

compose_mock_pack_checks() {
  local port="$1"
  mock_check_m1 "$port"
  mock_check_m2 "$port"
  mock_check_m3 "$port"
  mock_check_m4_m6 "$port"
  return 0
}
