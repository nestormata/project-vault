#!/usr/bin/env bash
# Story 68.2 AC-8: build and boot an out-of-monorepo consumer of a packed @project-vault/web-host.
#
#   scripts/web-host-consumer-fixture/run.sh <web-host.tgz> [variant]
#
# variant: `ok` (default), `missing-vendored-shared` (vendor/shared removed from the tarball) or
# `missing-dependency` (cron-parser removed from the tarball's dependencies). The two broken
# variants must fail; scripts/check-web-host-consumer-fixture.test.ts asserts that. `pv-responses`
# (Story 68.6 AC-3) is `ok` plus a recording of PV's responses (pv-responses.sh).
#
# Story 68.3: the variants named `compose*` install the composition kit tarball as well and compose
# a UI pack onto the installed web-host (instead of a plain copy) before building. They are driven
# by scripts/check-composition-kit-integration.test.ts and implemented in compose-mode.sh.
#
# Isolation is the point of this fixture. A build that "works" only because Node walked up into
# the monorepo's node_modules proves nothing, so:
#   - the consumer lives in a fresh `mktemp -d` outside the repository;
#   - every tool runs under `env -i` with only PATH (node's own directory and the system dirs),
#     HOME (a temp dir) and a fresh npm cache (WEB_HOST_FIXTURE_CACHE, or a temp dir);
#   - nothing is linked from the workspace: the only local package is the tarball itself;
#   - the installed web-host must resolve under the temp dir, and @project-vault/shared must not
#     be installed at all (it is vendored).
# @project-vault/extension-api comes from npm. Only while PV's exact version is not published yet
# (a bumped version on a PR, `npm view` E404) does scripts/check-web-host-consumer-fixture.test.ts
# pack it from the workspace and pass that tarball in WEB_HOST_FIXTURE_EXTENSION_API_TARBALL; a
# release run sets WEB_HOST_FIXTURE_REGISTRY_ONLY=1 and never gets one (Nestor 2026-10-02).
# The consumer's src/, static/ and vendor/ are a plain copy of the installed package's, which is
# the layout the composition kit (story 68-3) produces. The built server is then started on a free
# port and must render /login, because a `vite build` can succeed while the SSR output still fails
# to import vendored TypeScript at runtime.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <web-host.tgz> [ok|missing-vendored-shared|missing-dependency]" >&2
  exit 2
fi

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly FIXTURE_DIR
REPO_ROOT="$(cd "$FIXTURE_DIR/../.." && pwd)"
readonly REPO_ROOT
TARBALL="$(realpath "$1")"
readonly VARIANT="${2:-ok}"
COMPOSE_MODE=0
if [[ "$VARIANT" == compose* ]]; then
  COMPOSE_MODE=1
fi
readonly COMPOSE_MODE
NODE_BIN="$(command -v node)"
readonly NODE_BIN
NODE_DIR="$(dirname "$NODE_BIN")"
readonly NODE_DIR
readonly NPM_CLI="$NODE_DIR/../lib/node_modules/npm/bin/npm-cli.js"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/web-host-consumer.XXXXXX")"
readonly WORK
readonly APP="$WORK/app"
readonly CACHE="${WEB_HOST_FIXTURE_CACHE:-$WORK/npm-cache}"
SERVER_PID=''
VITEST_ARGS=()
API_PID=''
DEV_PID=''

cleanup() {
  local pid
  for pid in "$SERVER_PID" "$API_PID" "$DEV_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  if [[ "${WEB_HOST_FIXTURE_KEEP:-}" == '1' ]]; then
    echo "fixture: kept $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

log() {
  echo "fixture[$VARIANT]: $*"
}

case "$WORK" in
  "$REPO_ROOT"/*)
    echo "fixture: refusing to run inside the repository ($WORK)" >&2
    exit 1
    ;;
  *) ;;
esac

# Runs a command with a clean environment: no inherited npm/pnpm/node configuration.
clean_env() {
  env -i \
    PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" \
    HOME="$WORK/home" \
    PV_FIXTURE_VARIANT="$VARIANT" \
    npm_config_cache="$CACHE" \
    npm_config_update_notifier=false \
    "$@"
}

free_port() {
  clean_env "$NODE_BIN" -e '
    const server = require("node:net").createServer()
    server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close() })
  '
}

mkdir -p "$WORK/home" "$CACHE" "$APP"

# Variants rewrite a copy of the tarball; the original is never touched.
if [[ "$VARIANT" != 'ok' && "$VARIANT" != 'pv-responses' && "$COMPOSE_MODE" == 0 ]]; then
  mkdir -p "$WORK/repack"
  tar -xzf "$TARBALL" -C "$WORK/repack"
  case "$VARIANT" in
    missing-vendored-shared)
      rm -rf "$WORK/repack/package/vendor/shared"
      ;;
    missing-dependency)
      clean_env "$NODE_BIN" -e '
        const fs = require("node:fs")
        const file = process.argv[1]
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
        delete pkg.dependencies["cron-parser"]
        fs.writeFileSync(file, JSON.stringify(pkg, null, 2))
      ' "$WORK/repack/package/package.json"
      ;;
    *)
      echo "fixture: unknown variant $VARIANT" >&2
      exit 2
      ;;
  esac
  tar -czf "$WORK/web-host-variant.tgz" -C "$WORK/repack" package
  TARBALL="$WORK/web-host-variant.tgz"
fi
readonly TARBALL

EXTENSION_API_TARBALL=''
if [[ -n "${WEB_HOST_FIXTURE_EXTENSION_API_TARBALL:-}" ]]; then
  if [[ "${WEB_HOST_FIXTURE_REGISTRY_ONLY:-}" == '1' ]]; then
    echo 'fixture: WEB_HOST_FIXTURE_REGISTRY_ONLY=1 forbids a workspace @project-vault/extension-api tarball' >&2
    exit 1
  fi
  EXTENSION_API_TARBALL="$(realpath "$WEB_HOST_FIXTURE_EXTENSION_API_TARBALL")"
  cp "$EXTENSION_API_TARBALL" "$WORK/extension-api.tgz"
  EXTENSION_API_TARBALL="$WORK/extension-api.tgz"
fi
readonly EXTENSION_API_TARBALL

if [[ "$COMPOSE_MODE" == 1 ]]; then
  # shellcheck source=compose-mode.sh
  source "$FIXTURE_DIR/compose-mode.sh"
  compose_prepare_app
else
  cp "$FIXTURE_DIR/app/svelte.config.js" "$FIXTURE_DIR/app/vite.config.ts" "$FIXTURE_DIR/app/vitest.config.ts" "$APP/"
  # Generated, not committed: inside the repository, a tsconfig.json that extends a package which only
  # exists in the consumer would break Vite's tsconfig lookup for anything that loads these files.
  printf '%s\n' '{ "extends": ["./.svelte-kit/tsconfig.json", "@project-vault/web-host/tsconfig.base.json"] }' > "$APP/tsconfig.json"
fi

# The consumer's package.json is generated from the tarball's own manifest, so this fixture proves
# the exact-version contract is installable: every dependency and required peer at its exact
# version, plus web-host itself from the local tarball.
tar -xzOf "$TARBALL" package/package.json > "$WORK/web-host-package.json"
clean_env "$NODE_BIN" -e '
  const fs = require("node:fs")
  const [manifestPath, tarball, out, extensionApiTarball] = process.argv.slice(1)
  const host = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  // A top-level tarball of the same exact version satisfies the web-host dependency on it.
  const extensionApi = extensionApiTarball
    ? { "@project-vault/extension-api": "file:" + extensionApiTarball }
    : {}
  // Optional peers too: they are what the shipped unit tests need (jsdom, @testing-library/*).
  const peers = host.peerDependencies
  const pkg = {
    name: "web-host-consumer-fixture",
    private: true,
    type: "module",
    dependencies: {
      ...host.dependencies,
      ...extensionApi,
      "@project-vault/web-host": "file:" + tarball,
    },
    devDependencies: peers,
  }
  fs.writeFileSync(out, JSON.stringify(pkg, null, 2))
' "$WORK/web-host-package.json" "$TARBALL" "$APP/package.json" "$EXTENSION_API_TARBALL"
if [[ "$COMPOSE_MODE" == 1 ]]; then
  compose_extend_package_json
fi

log "installing into $APP (fresh npm cache, clean env)"
(cd "$APP" && clean_env "$NODE_BIN" "$NPM_CLI" install --no-audit --no-fund --ignore-scripts --loglevel=error)

readonly INSTALLED="$APP/node_modules/@project-vault/web-host"
case "$(realpath "$INSTALLED")" in
  "$WORK"/*) ;;
  *)
    echo "fixture: @project-vault/web-host resolved outside the temp dir: $(realpath "$INSTALLED")" >&2
    exit 1
    ;;
esac
if [[ -e "$APP/node_modules/@project-vault/shared" ]]; then
  echo "fixture: @project-vault/shared is installed; it must only exist as vendored source" >&2
  exit 1
fi

if [[ "$COMPOSE_MODE" == 1 ]]; then
  compose_assert_isolated
  compose_run
  if [[ "$VARIANT" == compose ]]; then
    compose_unknown_point
  fi
  compose_pipeline_to_sync
else
  cp -r "$INSTALLED/src" "$INSTALLED/static" "$APP/"
  if [[ -d "$INSTALLED/vendor" ]]; then
    cp -r "$INSTALLED/vendor" "$APP/"
  fi

  log 'paraglide compile, svelte-kit sync'
  (
    cd "$APP"
    clean_env "$NODE_BIN" node_modules/@inlang/paraglide-js/bin/run.js compile \
      --project node_modules/@project-vault/web-host/project.inlang --outdir ./src/lib/paraglide \
      --strategy cookie baseLocale --emit-ts-declarations --silent
    clean_env "$NODE_BIN" node_modules/@sveltejs/kit/svelte-kit.js sync
  )
fi

# Story 68.9 AC-13: pv-verify's guards and exclusions over the composed mini pack, with the mutations.
if [[ "$VARIANT" == 'compose-verify' ]]; then
  # shellcheck source=compose-verify.sh
  source "$FIXTURE_DIR/compose-verify.sh"
  compose_verify_cases
  exit 0
fi

if [[ "$VARIANT" == 'compose' || "$VARIANT" == 'compose-types-negative' ]]; then
  compose_svelte_check
fi
if [[ "$VARIANT" == 'compose-mock-pack' ]]; then
  mock_pack_svelte_check
  mock_pack_compose_check
  mock_pack_verify_guards
fi
if [[ "$VARIANT" == 'compose' ]]; then
  compose_plant_probe
  compose_assert_derived_routes
  compose_plant_parity_test
fi
# Story 68-6 AC-6 (code review): an invalid pack headerPolicy fails the composed tree's
# composed-hooks-init.test.ts with the start-up error, before anything is built or served.
if [[ "$VARIANT" == 'compose-bad-policy' ]]; then
  log 'composed-hooks-init.test.ts over a pack with an invalid headerPolicy (must fail)'
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/vitest/vitest.mjs run --reporter=dot \
    src/lib/composition/composed-hooks-init.test.ts)
  echo 'fixture: composed-hooks-init.test.ts passed over an invalid headerPolicy' >&2
  exit 1
fi
if [[ "$VARIANT" == 'compose-missing-with' ]]; then
  compose_remove_replacement_file
fi

# The dev variant never builds: it needs the API stub, then drives the Vite dev server.
start_api_stub() {
  API_PORT="$(free_port)"
  (
    exec env -i PATH="$NODE_DIR:/usr/bin:/bin" "$NODE_BIN" "$FIXTURE_DIR/api-stub.mjs" "$API_PORT"
  ) &
  API_PID=$!
  local _
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:${API_PORT}/ready" && return 0
    sleep 0.1
  done
  echo 'fixture: the API stub did not start' >&2
  exit 1
}

if [[ "$VARIANT" == 'compose-dev' ]]; then
  start_api_stub
  compose_dev "$API_PORT"
  exit 0
fi

log 'vite build'
(cd "$APP" && clean_env "$NODE_BIN" node_modules/vite/bin/vite.js build --logLevel warn)
if [[ ! -f "$APP/build/index.js" || ! -d "$APP/build/client/_app" ]]; then
  echo 'fixture: vite build produced no build/index.js or build/client/_app' >&2
  exit 1
fi
if [[ "$VARIANT" == 'compose-server-leak' || "$VARIANT" == 'compose-server-twin' ||
  "$VARIANT" == 'compose-replace-leak' || "$VARIANT" == 'compose-hooks-leak' ]]; then
  log "OK: vite build succeeded for $VARIANT"
  exit 0
fi
if [[ "$VARIANT" == 'compose' ]]; then
  compose_assert_css
fi

# Story 68.2 (Nestor 2026-10-02): the package ships PV's self-contained unit tests so a composer can
# run them over a composed tree (story 68-9). Run every shipped test, through the exported vitest
# config factory, over the copied source: they must all pass outside PV's monorepo. The Story 68-6
# full-override and response-recording variants only build and serve (the compose and ok variants
# already run the tests from the same tarball).
if [[ "$VARIANT" != 'compose-full-override' && "$VARIANT" != 'pv-responses' ]]; then
  SHIPPED_TESTS="$(find "$APP/src" -name '*.test.ts' | wc -l)"
  log "running the ${SHIPPED_TESTS} shipped unit test files with the exported vitest config"
  if [[ "$SHIPPED_TESTS" -eq 0 ]]; then
    echo 'fixture: the package shipped no unit tests' >&2
    exit 1
  fi
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/vitest/vitest.mjs run --reporter=dot "${VITEST_ARGS[@]}")
  log "OK: ${SHIPPED_TESTS} shipped unit test files passed"
fi

# A stand-in for the PV API (api-stub.mjs): /ready and /health say "ready, native login enabled",
# which is all /login's server-side load needs to render the sign-in form.
start_api_stub
readonly API_PORT

PORT="$(free_port)"
readonly PORT
log "starting the built server on 127.0.0.1:$PORT (API stub on $API_PORT)"
(
  cd "$APP"
  exec env -i PATH="$NODE_DIR:/usr/bin:/bin" HOME="$WORK/home" HOST=127.0.0.1 PORT="$PORT" \
    ORIGIN="http://127.0.0.1:$PORT" API_BASE_URL="http://127.0.0.1:$API_PORT" \
    "$NODE_BIN" build/index.js > "$WORK/server.out" 2> "$WORK/server.err"
) &
SERVER_PID=$!

STATUS=''
for _ in $(seq 1 60); do
  STATUS="$(curl -s -o "$WORK/login.html" -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)"
  if [[ "$STATUS" != '000' && -n "$STATUS" ]]; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if grep -E "ERR_|Cannot find (module|package)" "$WORK/server.err" >&2; then
  echo 'fixture: the built server reported a module-resolution error' >&2
  exit 1
fi
if [[ "$STATUS" != '200' ]]; then
  echo "fixture: GET /login answered HTTP ${STATUS:-none}" >&2
  cat "$WORK/server.err" >&2
  exit 1
fi
if ! grep -q '<form' "$WORK/login.html" || ! grep -q '<title>Sign in | Project Vault</title>' "$WORK/login.html"; then
  echo 'fixture: /login did not server-render the sign-in form' >&2
  exit 1
fi
if [[ "$COMPOSE_MODE" == 1 ]]; then
  compose_http_checks "$PORT"
fi
if [[ "$VARIANT" == 'pv-responses' ]]; then
  # shellcheck source=pv-responses.sh
  source "$FIXTURE_DIR/pv-responses.sh"
  pv_record_responses "$PORT"
fi
log "OK: /login server-rendered the sign-in form (HTTP 200) from $(basename "$TARBALL")"
