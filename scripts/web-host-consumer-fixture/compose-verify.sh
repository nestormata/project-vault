#!/usr/bin/env bash
# Story 68.9 AC-13: PV's web guards and PV's unit tests over the REAL packed web-host with the mini pack
# composed onto it, through the kit's `pv-verify`. Sourced by run.sh for the `compose-verify` variant
# (after compose_run and compose_pipeline_to_sync), so it uses compose-mode.sh's helpers and run.sh's
# APP, INSTALLED, WORK, NODE_BIN, clean_env and log.
#
#   clean run          pv-verify --only guards over the composed mini pack exits 0
#   mutations 1-6, 8   each applied to a COPY of the pack, composed into the same app, and expected red
#   mutation 7         a PV file the pack overrides: its test is in the lock's excludedPvTests and a
#                      failing assertion planted in the composed copy of that test does not run
#   mutation 10        the app's own vitest config without pvHooks() makes pv-verify --only tests red
#   mutation 9         the pack overrides a guard test file itself: the pristine guard still runs, the
#                      lock records it, and the guards stay green
#
# The unit-test step of pv-verify runs here with the app's own vitest.config.ts (Story 68-21) and a
# mutation without pvHooks() proves the run is not vacuous; exclusion is proven by mutation 7.

readonly COMPOSE_BIN='node_modules/@project-vault/composition-kit/dist/cli.js'

# A fresh copy of the mini pack for one mutation.
verify_pack_copy() { # name -> prints the directory
  local copy="$WORK/pack-$1"
  rm -rf "$copy"
  cp -r "$COMPOSITION_KIT_FIXTURES/mini-pack" "$copy"
  ln -s "$APP/node_modules" "$copy/node_modules"
  printf '%s' "$copy"
  return 0
}

# pv-compose a pack into the app. Output in $WORK/verify-compose.out; the exit status is returned.
verify_compose() { # pack
  local pack="$1" status=0
  (cd "$APP" && clean_env PV_FIXTURE_HOST="$INSTALLED" "$NODE_BIN" "$COMPOSE_BIN" \
    --pack "$pack" --module-pack "$APP") > "$WORK/verify-compose.out" 2>&1 || status=$?
  return "$status"
}

# pv-verify over the app, through the node_modules/.bin symlink (Story 68-20). Output in $WORK/verify.out; the exit status is returned.
verify_run() { # args...
  local status=0
  (cd "$APP" && clean_env "$VERIFY_LINK" --app "$APP" --host "$INSTALLED" "$@") \
    > "$WORK/verify.out" 2>&1 || status=$?
  return "$status"
}

verify_fail() {
  echo "fixture: $*" >&2
  echo '--- pv-compose ---' >&2
  cat "$WORK/verify-compose.out" >&2 || true
  echo '--- pv-verify ---' >&2
  cat "$WORK/verify.out" >&2 || true
  exit 1
}

# Compose a mutated pack (it must compose), run the guards over it, and expect a non-zero exit whose
# output names the rule.
verify_mutation_red() { # name pack needle
  local name="$1" pack="$2" needle="$3" status=0
  verify_compose "$pack" || verify_fail "mutation $name: the mutated pack did not compose"
  verify_run --only guards || status=$?
  if [[ "$status" != '1' ]] || ! grep -qF -- "$needle" "$WORK/verify.out"; then
    verify_fail "mutation $name: pv-verify exited $status without: $needle"
  fi
  log "OK: mutation $name is red ($needle)"
  return 0
}

# Add a PV file path to the pack manifest's OVERRIDES list (the manifest declares an override only
# while its file exists in the pack).
verify_declare_override() { # pack path
  local pack="$1" path="$2"
  sed -i "s#^  'static/favicon.png',#  'static/favicon.png',\n  '$path',#" "$pack/pv-ui.manifest.ts"
  return 0
}

verify_mutate_html() { # pack
  local pack="$1"
  printf '<script lang="ts">\n  let { userBio }: { userBio: string } = $props()\n</script>\n<div>{@html userBio}</div>\n' > "$pack/src/lib/BadHtml.svelte"
  return 0
}

verify_mutate_storage() { # pack
  local pack="$1"
  printf "export const remember = (value: string): void => globalThis.sessionStorage?.setItem('cm:other', value)\n" > "$pack/src/lib/session-cache.ts"
  return 0
}

verify_mutate_key() { # pack: the declared file uses a key its entry does not declare
  local pack="$1"
  sed -i "s#'cm:billing-draft'#'cm:other-draft'#" "$pack/src/lib/billing-draft.ts"
  return 0
}

verify_mutate_fetch() { # pack
  local pack="$1"
  printf "export const call = (base: string | undefined = process.env.API_BASE_URL): Promise<Response> => globalThis.fetch(String(base))\n" > "$pack/src/lib/server/cm-crm.ts"
  return 0
}

verify_mutate_input() { # pack
  local pack="$1"
  printf '<input id="cm-note" />\n' > "$pack/src/lib/BadInput.svelte"
  return 0
}

verify_mutate_css() { # pack: an app.css override that drops source(none)
  local pack="$1"
  printf '@import "tailwindcss";\n@source "./**/*.{svelte,ts}";\n' > "$pack/src/app.css"
  verify_declare_override "$pack" 'src/app.css'
  return 0
}

# Mutations 3 and 8 fail the COMPOSITION, not a guard.
verify_compose_red() { # name pack needle
  local name="$1" pack="$2" needle="$3" status=0
  verify_compose "$pack" || status=$?
  if [[ "$status" != '1' ]] || ! grep -qF -- "$needle" "$WORK/verify-compose.out"; then
    verify_fail "mutation $name: pv-compose exited $status without: $needle"
  fi
  log "OK: mutation $name fails the composition ($needle)"
  return 0
}

# Mutation 7: a PV file the pack overrides (with identical bytes, so only the exclusion changes).
verify_excluded_test() {
  local pack target='src/lib/utils/format-bytes.ts' test_file='src/lib/utils/format-bytes.test.ts'
  pack="$(verify_pack_copy exclusion)"
  mkdir -p "$pack/src/lib/utils"
  cp "$INSTALLED/$target" "$pack/$target"
  verify_declare_override "$pack" "$target"
  verify_compose "$pack" || verify_fail 'mutation 7: the pack did not compose'
  if ! grep -qF "\"$test_file\"" "$APP/composition.lock.json"; then
    verify_fail "mutation 7: $test_file is not in excludedPvTests"
  fi
  compose_pipeline_to_sync
  printf '\nimport { it as plantedIt } from "vitest"\nplantedIt("planted failing assertion", () => { throw new Error("planted") })\n' >> "$APP/$test_file"
  local status=0
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/vitest/vitest.mjs run "$test_file") > "$WORK/verify.out" 2>&1 || status=$?
  if [[ "$status" == '0' ]] || ! grep -qF 'No test files found' "$WORK/verify.out" || grep -qF 'planted failing assertion' "$WORK/verify.out"; then
    verify_fail "mutation 7: the excluded test still ran (exit $status)"
  fi
  (cd "$APP" && clean_env "$NODE_BIN" node_modules/vitest/vitest.mjs run src/lib/utils/reset-on.test.ts) > "$WORK/verify.out" 2>&1 ||
    verify_fail 'mutation 7: a PV test the pack did not touch no longer runs'
  log "OK: mutation 7: $test_file is excluded by the lock, a planted failure in it does not run, and an untouched PV test still does"
  return 0
}

# Mutation 9: the pack overrides a guard test file itself.
verify_overridden_guard() {
  local pack guard='src/lib/security/static-hardening.test.ts' status=0
  pack="$(verify_pack_copy guard-override)"
  mkdir -p "$pack/src/lib/security"
  printf "import { it } from 'vitest'\nit('a pack that blinds its own copy of the guard', () => undefined)\n" > "$pack/$guard"
  verify_declare_override "$pack" "$guard"
  verify_compose "$pack" || verify_fail 'mutation 9: the pack did not compose'
  if ! grep -qF "guard-file-overridden: $guard" "$APP/composition.lock.json"; then
    verify_fail "mutation 9: the lock does not record the overridden guard file $guard"
  fi
  verify_run --only guards || status=$?
  if [[ "$status" != '0' ]] || ! grep -qF "guard-file-overridden $guard" "$WORK/verify.out"; then
    verify_fail "mutation 9: the pristine guard did not run green over the overridden copy (exit $status)"
  fi
  log 'OK: mutation 9: the pristine static-hardening guard ran over a pack-overridden copy, green, and the override is recorded'
  return 0
}

# Story 68-21: pv-verify --only tests runs the app's own vitest.config.ts (pvHooks, pvNav, pvReplace),
# so the composed mini pack's hooks, nav and replacement resolve exactly as in the build. The mutation
# drops pvHooks() from a copy of that config: the same run must go red, so the assertion is not vacuous.
verify_own_config_tests() {
  local status=0 config="$APP/vitest.config.ts" backup="$WORK/vitest.config.ts.orig"
  verify_run --only tests || status=$?
  if [[ "$status" != '0' ]] || ! grep -Eq 'pv-verify: tests: [1-9][0-9]* run' "$WORK/verify.out" ||
    ! grep -qF 'config vitest.config.ts' "$WORK/verify.out"; then
    verify_fail "pv-verify --only tests with the app's own config exited $status or did not report its run"
  fi
  log "OK: pv-verify tests ran the app's own vitest.config.ts over the composed mini pack (hooks, nav, replacement)"
  cp "$config" "$backup"
  sed -i '/pvHooks({ appRoot: composedRoot }),/d' "$config"
  status=0
  verify_run --only tests || status=$?
  cp "$backup" "$config"
  if [[ "$status" != '1' ]]; then
    verify_fail "mutation 10: pv-verify tests exited $status over a config without pvHooks()"
  fi
  log 'OK: mutation 10 is red (the app config without pvHooks() fails the same tests run)'
  return 0
}

compose_verify_cases() {
  local status=0 pack
  verify_run --only guards || status=$?
  if [[ "$status" != '0' ]]; then
    verify_fail "pv-verify --only guards over the composed mini pack exited $status"
  fi
  grep -q 'pv-verify: guards: .* passed, 0 failed' "$WORK/verify.out" || verify_fail 'the guards summary line is missing'
  log 'OK: pv-verify guards pass over the composed mini pack'
  verify_own_config_tests

  pack="$(verify_pack_copy html)"
  verify_mutate_html "$pack"
  verify_mutation_red 1-raw-html "$pack" 'uses raw HTML rendering'
  pack="$(verify_pack_copy storage)"
  verify_mutate_storage "$pack"
  verify_mutation_red 2-storage-no-entry "$pack" 'uses sessionStorage and no guard entry names it'
  pack="$(verify_pack_copy key)"
  verify_mutate_key "$pack"
  verify_mutation_red 2b-storage-other-key "$pack" "which its entry does not declare"
  pack="$(verify_pack_copy stale)"
  sed -i "s#src/lib/billing-draft.ts#src/lib/missing.ts#" "$pack/pv-guards.ts"
  verify_compose_red 3-stale-entry "$pack" 'maps to no composed file (stale carve-out)'
  pack="$(verify_pack_copy fetch)"
  verify_mutate_fetch "$pack"
  verify_mutation_red 4-raw-fetch "$pack" 'raw global fetch next to the API base URL'
  pack="$(verify_pack_copy input)"
  verify_mutate_input "$pack"
  verify_mutation_red 5-input-without-description "$pack" 'missing-description'
  pack="$(verify_pack_copy css)"
  verify_mutate_css "$pack"
  verify_mutation_red 6-css-drops-source-none "$pack" 'source(none)'
  pack="$(verify_pack_copy release)"
  printf "import { defineGuardEntries } from '@project-vault/composition-kit'\nexport default defineGuardEntries({ browserStorage: { release: ['src/routes/(app)/dashboard/+page.svelte'] } })\n" > "$pack/pv-guards.ts"
  verify_compose_red 8-release-untouched "$pack" 'cannot release an entry for a file CM did not change'

  verify_excluded_test
  verify_overridden_guard
  # Leave the app composed from the unmodified pack, so a later step sees the real thing.
  verify_compose "$PACK" || verify_fail 'recomposing the unmodified mini pack failed'
  log 'OK: pv-verify proved every guard and exclusion mutation on the real packed web-host'
  return 0
}
