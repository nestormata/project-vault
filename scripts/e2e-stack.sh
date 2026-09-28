#!/usr/bin/env bash
# Story 66.1: the ONE way to start the Playwright e2e docker-compose stack
# (docker-compose.yml + docker-compose.e2e.yml), used by both `make e2e` and nightly.yml's e2e job.
#
# Why throwaway secrets: the api runs with NODE_ENV=production, and since Story 1-24 env.ts rejects
# the base compose file's `${VAR:-<64 × one letter>}` dev-default secrets. So every stack start
# generates 12 fresh, distinct, CSPRNG values (openssl rand -hex 32) that exist ONLY in this
# process's environment, exported for compose interpolation. They are never written to disk,
# $GITHUB_ENV/$GITHUB_OUTPUT or argv, and never printed; under GitHub Actions each one is
# registered with ::add-mask:: before anything else prints. Production validation is not weakened.
#
# A value the caller already exported is kept (Story 66.1 D-3/N-3), after two fail-fast checks:
# not one of the 12 known dev literals, and not a duplicate of another key.
#
# Usage:
#   scripts/e2e-stack.sh up         generate secrets, `docker compose … up --build -d`; dump on failure
#   scripts/e2e-stack.sh wait       poll /health on API_HOST_PORT; dump + exit 1 on timeout/exit
#   scripts/e2e-stack.sh start      up + wait in one process (what `make e2e` runs)
#   scripts/e2e-stack.sh self-test  exercise generation, pre-checks and redaction without docker
#
# Gotcha (D-2): never run `docker compose … up` for this stack outside this script. Without the
# secrets exported, compose falls back to the dev literals and the recreated api dies at boot.
# Never add xtrace to this script, and never dump resolved config (`docker compose config`,
# `docker inspect`, env/printenv): all of those print secret values.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.e2e.yml)
# Must equal docker-compose.yml's api dev-default secrets (asserted by scripts/e2e-stack.test.ts).
SECRET_NAMES=(
  SESSION_SECRET
  REFRESH_TOKEN_HMAC_SECRET
  TOTP_REPLAY_HMAC_SECRET
  MFA_PENDING_SESSION_HMAC_SECRET
  INVITATION_TOKEN_HMAC_SECRET
  RECOVERY_TOKEN_HMAC_SECRET
  API_KEY_HMAC_SECRET
  MACHINE_JWT_SECRET
  STATUS_PAGE_TOKEN_HMAC_SECRET
  ERASURE_EMAIL_HASH_SECRET
  SSO_STATE_HMAC_SECRET
  OPERATIONAL_STATUS_TOKEN_HMAC_SECRET
)
ONE_SHOT_SERVICES=" migrate admin-provision "
PRESET_NAMES=()

say() { printf 'e2e-stack: %s\n' "$*"; }
warn() { printf 'e2e-stack: %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}

# 32 CSPRNG bytes as 64 lowercase hex; node fallback when openssl is absent.
generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  fi
}

# The 12 dev literals (env.ts KNOWN_DEV_SECRET_VALUES) are 64 × one letter in a..l. Checked by
# shape, so the literal values are never copied into this script.
is_dev_literal() {
  local value="$1" first="${1:0:1}"
  [[ ${#value} -eq 64 && "$first" == [a-l] && -z "${value//"$first"/}" ]]
}

is_placeholder() {
  local lowered="${1,,}"
  [[ "$lowered" == *change-me* || "$lowered" == *dev-only* || "$lowered" == *placeholder* ]]
}

emit_masks() {
  local name
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    for name in "${SECRET_NAMES[@]}"; do printf '::add-mask::%s\n' "${!name}"; done
  fi
}

# Generates every unset/empty secret (exported for compose), keeps valid presets, then checks the
# whole set. Prints names only.
prepare_secrets() {
  local name value index other
  PRESET_NAMES=()
  for name in "${SECRET_NAMES[@]}"; do
    if [[ -n "${!name:-}" ]]; then
      PRESET_NAMES+=("$name")
      export "${name?}"
    else
      value="$(generate_secret)"
      [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die "secret generator returned a malformed value for $name"
      export "$name=$value"
    fi
  done
  value=""
  emit_masks
  for name in "${PRESET_NAMES[@]}"; do
    if is_dev_literal "${!name}"; then
      die "$name is a known dev literal; unset it or supply a real throwaway"
    fi
    say "using caller-provided $name"
  done
  for ((index = 0; index < ${#SECRET_NAMES[@]}; index++)); do
    name="${SECRET_NAMES[index]}"
    for other in "${SECRET_NAMES[@]:0:index}"; do
      [[ "${!name}" != "${!other}" ]] || die "$name duplicates $other"
    done
  done
}

# Replaces every secret value present in this process's environment with ***. Values are read
# from ENVIRON inside awk, never from argv, and matched literally (index, not regex). When
# E2E_CAPTURE names a file, the redacted lines are also appended to it.
redact() {
  E2E_REDACT_NAMES="${SECRET_NAMES[*]}" awk '
    function scrub(s, v,   out, p) {
      out = ""
      while ((p = index(s, v)) > 0) { out = out substr(s, 1, p - 1) "***"; s = substr(s, p + length(v)) }
      return out s
    }
    BEGIN { n = split(ENVIRON["E2E_REDACT_NAMES"], names, " ") }
    {
      line = $0
      for (i = 1; i <= n; i++) { v = ENVIRON[names[i]]; if (length(v) > 0) line = scrub(line, v) }
      print line
      fflush()
      if (ENVIRON["E2E_CAPTURE"] != "") { print line >> ENVIRON["E2E_CAPTURE"] }
    }'
}

compose() {
  docker compose "${COMPOSE_FILES[@]}" "$@"
}

# Container state, secret-free: never `docker inspect` (it prints env).
compose_states() {
  compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null || true
}

dump_diagnostics() {
  {
    warn "container status (docker compose ps -a):"
    compose ps -a 2>&1 || true
    warn "recent logs (migrate, admin-provision, api):"
    compose logs --no-color --tail=200 migrate admin-provision api 2>&1 || true
  } | redact >&2 || true
}

# Services that exited unexpectedly: any non-zero exit, or any long-running service that stopped.
failed_containers() {
  local service state code failed=""
  while read -r service state code; do
    [[ -n "${service:-}" ]] || continue
    case "$state" in
      exited | dead | restarting)
        if [[ "${code:-0}" != "0" || "$ONE_SHOT_SERVICES" != *" $service "* ]]; then
          failed+="${failed:+, }$service (exit ${code:-?})"
        fi
        ;;
    esac
  done <<<"$(compose_states)"
  printf '%s' "$failed"
}

api_port() {
  local port="${API_HOST_PORT:-}"
  if [[ -z "$port" && -f .env ]]; then
    port="$(grep -m1 '^API_HOST_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
  fi
  printf '%s' "${port:-3000}"
}

positive_int() {
  [[ "$2" =~ ^[0-9]+$ ]] || die "$1 must be a non-negative integer"
  printf '%s' "$2"
}

UP_CAPTURE=""
remove_up_capture() {
  if [[ -n "$UP_CAPTURE" ]]; then rm -f "$UP_CAPTURE"; fi
}

cmd_up() {
  local status=0
  prepare_secrets
  say "$(docker compose version 2>&1 | head -n1 || true)"
  # Redacted `up` output, kept only to detect a host-port collision; mode 600 (umask), outside
  # the repo, removed on exit.
  UP_CAPTURE="$(mktemp)"
  trap remove_up_capture EXIT
  compose up --build -d 2>&1 | E2E_CAPTURE="$UP_CAPTURE" redact || status=$?
  if [[ "$status" -ne 0 ]]; then
    dump_diagnostics
    if grep -q 'port is already allocated' "$UP_CAPTURE"; then
      warn "host port collision; re-run 'make fix-ports' and retry"
    fi
    die "docker compose up failed (exit $status)"
  fi
}

cmd_wait() {
  local attempts interval port url started code=0 last_code=0 attempt failed
  attempts="$(positive_int E2E_HEALTH_ATTEMPTS "${E2E_HEALTH_ATTEMPTS:-40}")"
  interval="$(positive_int E2E_HEALTH_INTERVAL_SECONDS "${E2E_HEALTH_INTERVAL_SECONDS:-3}")"
  port="$(api_port)"
  url="http://localhost:${port}/health"
  started=$SECONDS
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    code=0
    curl -sf -o /dev/null --max-time 5 "$url" || code=$?
    if [[ "$code" -eq 0 ]]; then
      say "api healthy after $((SECONDS - started))s"
      compose logs --no-color --tail=20 api 2>&1 | redact || true
      return 0
    fi
    last_code="$code"
    failed="$(failed_containers)"
    if [[ -n "$failed" ]]; then
      warn "container exited: $failed"
      dump_diagnostics
      die "API never became ready on $url after $((SECONDS - started))s (last curl exit $last_code)"
    fi
    case "$code" in
      7 | 52 | 56) ;;
      *) warn "health attempt $attempt/$attempts: curl exit $code; retrying until the deadline" ;;
    esac
    if [[ "$attempt" -lt "$attempts" ]]; then sleep "$interval"; fi
  done
  dump_diagnostics
  die "API never became ready on $url after $((SECONDS - started))s (last curl exit $last_code)"
}

cmd_self_test() {
  local name first second probe redacted
  local -a first_set=()
  prepare_secrets
  for name in "${SECRET_NAMES[@]}"; do
    if ! [[ " ${PRESET_NAMES[*]} " == *" $name "* ]]; then
      [[ "${!name}" =~ ^[0-9a-f]{64}$ ]] || die "self-test: $name is not 64 lowercase hex"
    fi
    ! is_dev_literal "${!name}" || die "self-test: $name is a dev literal"
    ! is_placeholder "${!name}" || die "self-test: $name looks like a placeholder"
    first_set+=("${!name}")
  done
  [[ ${#first_set[@]} -eq 12 ]] || die "self-test: expected 12 secrets, got ${#first_set[@]}"
  say "12 distinct throwaway secrets OK (64 hex chars each)"

  first="${SECRET_NAMES[0]}"
  probe="${!first}"
  redacted="$(redact <<<"before ${probe} after")"
  [[ "$redacted" == "before *** after" ]] || die "self-test: redaction filter failed"
  say "redaction filter OK"

  for name in "${SECRET_NAMES[@]}"; do unset "$name"; done
  GITHUB_ACTIONS="" prepare_secrets
  second="${!first}"
  [[ "$second" != "${first_set[0]}" ]] || die "self-test: a second run reused a value"
  say "a second generation produced fresh values OK"
}

usage() {
  warn "usage: scripts/e2e-stack.sh {up|wait|start|self-test}"
  exit 2
}

case "${1:-}" in
  up) cmd_up ;;
  wait) cmd_wait ;;
  start)
    cmd_up
    cmd_wait
    ;;
  self-test) cmd_self_test ;;
  *) usage ;;
esac
