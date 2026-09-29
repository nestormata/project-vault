#!/usr/bin/env bash
# Private PKI for the project-vault Fly.io demo's internal hops (Story 43.16):
# web -> api (mTLS), api -> db and operator -> db (TLS 1.3 + client certificates).
#
# One long-lived CA (ECDSA P-256, 825 days) lives in two GitHub Actions secrets; every leaf is
# minted from it per run, so leaf rotation needs no GitHub change. See
# docs/runbooks/fly-internal-tls.md.
#
# Subcommands:
#   init-ca --out <dir>        Local, one time (the operator): writes ca.crt / ca.key (0600, dir
#                              0700) plus ca.crt.b64 / ca.key.b64 for `gh secret set ... < file`.
#                              Refuses a non-empty directory.
#   issue-leaves               From scripts/fly-setup.sh: issues the api server, api -> db client,
#                              web client and db server leaves (397 days) and stages them as Fly
#                              secrets. Everything is generated and verified before the first
#                              `flyctl secrets import --stage`.
#   issue-operator --out <dir> From scripts/fly-migrate.sh / fly-reset.sh: a short-lived (1 day,
#                              the OpenSSL 3.0 floor) `fly-operator` client certificate plus the CA
#                              into a caller-owned directory the caller removes.
#
# Env (issue-leaves, issue-operator): FLY_INTERNAL_CA_CERT_B64, FLY_INTERNAL_CA_KEY_B64 (base64 of
# the CA PEMs). issue-leaves also reads FLY_API_APP / FLY_WEB_APP / FLY_DB_APP (defaults below).
# OPENSSL overrides the openssl binary.
#
# Never prints key or certificate bodies — only subjects, SANs and notAfter. The CA key is only
# ever decoded into a mktemp -d directory (0700, files 0600) that an EXIT trap removes.
set -euo pipefail
umask 077

OPENSSL="${OPENSSL:-openssl}"
API_APP="${FLY_API_APP:-project-vault-demo-api}"
WEB_APP="${FLY_WEB_APP:-project-vault-demo-web}"
DB_APP="${FLY_DB_APP:-project-vault-demo-db}"
LEAF_DAYS=397
CA_DAYS=825
OPERATOR_DAYS=1
RERUN_MESSAGE="re-run scripts/fly-internal-tls.sh before any deploy — staged TLS secrets may be inconsistent across apps"

usage() {
  echo "usage: $0 init-ca --out <dir> | issue-leaves | issue-operator --out <dir>" >&2
  exit 2
}

require_openssl() {
  command -v "$OPENSSL" >/dev/null 2>&1 || { echo "openssl not found (OPENSSL=${OPENSSL})" >&2; exit 1; }
}

# openssl chatter (e.g. "Certificate request self-signature ok") goes to /dev/null: some failure
# paths can print key material, so its stderr is never relayed. Errors surface as our own message.
ossl() {
  "$OPENSSL" "$@" >/dev/null 2>&1
}

new_ec_key_and_csr() {
  local stem="$1" subject="$2"
  ossl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "${stem}.key" -out "${stem}.csr" -subj "$subject" \
    || { echo "failed to generate a key for ${subject}" >&2; return 1; }
}

# sign_leaf <stem> <ca-dir> <days> <extensions-file>
sign_leaf() {
  local stem="$1" ca_dir="$2" days="$3" ext="$4"
  ossl x509 -req -in "${stem}.csr" -CA "${ca_dir}/ca.crt" -CAkey "${ca_dir}/ca.key" \
    -set_serial "0x$("$OPENSSL" rand -hex 16)" -days "$days" -extfile "$ext" -out "${stem}.crt" \
    || { echo "failed to sign ${stem##*/}" >&2; return 1; }
  rm -f "${stem}.csr"
}

# write_ext <file> <eku> [subjectAltName]
write_ext() {
  local file="$1" eku="$2" san="${3:-}"
  {
    echo "basicConstraints=critical,CA:FALSE"
    echo "keyUsage=critical,digitalSignature"
    echo "extendedKeyUsage=${eku}"
    if [[ -n "$san" ]]; then echo "subjectAltName=${san}"; fi
  } >"$file"
}

public_key_of_cert() {
  local cert="$1"
  "$OPENSSL" x509 -in "$cert" -noout -pubkey 2>/dev/null
}
public_key_of_key() {
  local key="$1"
  "$OPENSSL" pkey -in "$key" -pubout 2>/dev/null
}

key_matches_cert() {
  local key="$1" cert="$2"
  [[ "$(public_key_of_cert "$cert")" == "$(public_key_of_key "$key")" ]]
}

verify_leaf() {
  local stem="$1" ca_dir="$2"
  ossl verify -CAfile "${ca_dir}/ca.crt" "${stem}.crt" || { echo "${stem##*/} does not verify against the CA" >&2; return 1; }
  key_matches_cert "${stem}.key" "${stem}.crt" || { echo "${stem##*/} key does not match its certificate" >&2; return 1; }
}

describe_cert() {
  local label="$1" cert="$2"
  echo "  ${label}: $("$OPENSSL" x509 -in "$cert" -noout -subject 2>/dev/null)"
  local san
  san="$("$OPENSSL" x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ')"
  if [[ -n "$san" ]]; then echo "    subjectAltName=${san}"; fi
  echo "    $("$OPENSSL" x509 -in "$cert" -noout -enddate 2>/dev/null)"
}

b64() {
  local file="$1"
  base64 -w0 <"$file"
}

# Decodes the CA from the environment into <dir>/ca.crt and <dir>/ca.key (0600) and checks the pair.
load_ca() {
  local dir="$1"
  : "${FLY_INTERNAL_CA_CERT_B64:?Set FLY_INTERNAL_CA_CERT_B64 (base64 of the internal CA certificate; GitHub secret FLY_DEMO_INTERNAL_CA_CERT_B64)}"
  : "${FLY_INTERNAL_CA_KEY_B64:?Set FLY_INTERNAL_CA_KEY_B64 (base64 of the internal CA key; GitHub secret FLY_DEMO_INTERNAL_CA_KEY_B64)}"
  printf '%s' "$FLY_INTERNAL_CA_CERT_B64" | base64 -d >"${dir}/ca.crt" 2>/dev/null \
    || { echo "FLY_INTERNAL_CA_CERT_B64 is not valid base64" >&2; return 1; }
  printf '%s' "$FLY_INTERNAL_CA_KEY_B64" | base64 -d >"${dir}/ca.key" 2>/dev/null \
    || { echo "FLY_INTERNAL_CA_KEY_B64 is not valid base64" >&2; return 1; }
  ossl x509 -in "${dir}/ca.crt" -noout || { echo "FLY_INTERNAL_CA_CERT_B64 is not a PEM certificate" >&2; return 1; }
  ossl pkey -in "${dir}/ca.key" -noout || { echo "FLY_INTERNAL_CA_KEY_B64 is not a PEM private key" >&2; return 1; }
  key_matches_cert "${dir}/ca.key" "${dir}/ca.crt" \
    || { echo "FLY_INTERNAL_CA_KEY_B64 does not match FLY_INTERNAL_CA_CERT_B64" >&2; return 1; }
}

parse_out() {
  [[ "${1:-}" == "--out" && -n "${2:-}" ]] || usage
  OUT_DIR="$2"
}

cmd_init_ca() {
  parse_out "$@"
  if [[ -e "$OUT_DIR" ]]; then
    [[ -d "$OUT_DIR" ]] || { echo "${OUT_DIR} exists and is not a directory" >&2; exit 1; }
    [[ -z "$(ls -A "$OUT_DIR")" ]] || { echo "${OUT_DIR} is not empty; refusing to overwrite a CA" >&2; exit 1; }
  else
    mkdir -p "$OUT_DIR"
  fi
  chmod 0700 "$OUT_DIR"
  ossl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "${OUT_DIR}/ca.key" -out "${OUT_DIR}/ca.crt" -days "$CA_DAYS" \
    -subj "/CN=project-vault-fly-demo-internal-ca" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    || { echo "failed to create the CA" >&2; exit 1; }
  b64 "${OUT_DIR}/ca.crt" >"${OUT_DIR}/ca.crt.b64"
  b64 "${OUT_DIR}/ca.key" >"${OUT_DIR}/ca.key.b64"
  chmod 0600 "${OUT_DIR}"/ca.crt "${OUT_DIR}"/ca.key "${OUT_DIR}"/ca.crt.b64 "${OUT_DIR}"/ca.key.b64
  echo "== Internal CA created =="
  echo "  ${OUT_DIR}/ca.crt, ${OUT_DIR}/ca.key, ${OUT_DIR}/ca.crt.b64, ${OUT_DIR}/ca.key.b64"
  describe_cert "CA" "${OUT_DIR}/ca.crt"
  echo "Next: gh secret set FLY_DEMO_INTERNAL_CA_CERT_B64 < ${OUT_DIR}/ca.crt.b64"
  echo "      gh secret set FLY_DEMO_INTERNAL_CA_KEY_B64 < ${OUT_DIR}/ca.key.b64"
  echo "Then store ${OUT_DIR} offline or delete it securely."
}

# stage_secrets <app> <NAME=file-to-base64>...
# Every value is encoded and checked BEFORE flyctl runs: callers invoke this in an `if !` context,
# where `set -e` is off, so a failed or empty encode is caught explicitly and nothing is staged for
# that app rather than an empty secret.
stage_secrets() {
  local app="$1"; shift
  local pair name value payload=""
  for pair in "$@"; do
    name="${pair%%=*}"
    value="$(b64 "${pair#*=}")" || { echo "failed to encode ${name}; nothing staged to ${app}" >&2; return 1; }
    [[ -n "$value" ]] || { echo "${name} encoded to an empty value; nothing staged to ${app}" >&2; return 1; }
    payload+="${name}=${value}"$'\n'
  done
  printf '%s' "$payload" | flyctl secrets import --stage -a "$app" >/dev/null
}

cmd_issue_leaves() {
  TLS_DIR="$(mktemp -d)"
  trap 'rm -rf "$TLS_DIR"' EXIT
  load_ca "$TLS_DIR"

  write_ext "${TLS_DIR}/api-server.ext" serverAuth "DNS:${API_APP}.internal"
  write_ext "${TLS_DIR}/api-db-client.ext" clientAuth
  write_ext "${TLS_DIR}/web-client.ext" clientAuth
  write_ext "${TLS_DIR}/db-server.ext" serverAuth "DNS:${DB_APP}.internal,DNS:localhost"

  local leaf subject
  for leaf in api-server api-db-client web-client db-server; do
    case "$leaf" in
      api-server) subject="/CN=${API_APP}.internal" ;;
      api-db-client) subject="/CN=${API_APP}" ;;
      web-client) subject="/CN=${WEB_APP}" ;;
      db-server) subject="/CN=${DB_APP}.internal" ;;
      *)
        echo "internal error: unknown leaf ${leaf}" >&2
        return 1
        ;;
    esac
    new_ec_key_and_csr "${TLS_DIR}/${leaf}" "$subject"
    sign_leaf "${TLS_DIR}/${leaf}" "$TLS_DIR" "$LEAF_DAYS" "${TLS_DIR}/${leaf}.ext"
    verify_leaf "${TLS_DIR}/${leaf}" "$TLS_DIR"
  done

  echo "== Internal TLS leaves issued (${LEAF_DAYS} days) =="
  describe_cert "api server" "${TLS_DIR}/api-server.crt"
  describe_cert "api -> db client" "${TLS_DIR}/api-db-client.crt"
  describe_cert "web client" "${TLS_DIR}/web-client.crt"
  describe_cert "db server" "${TLS_DIR}/db-server.crt"

  echo "== Staging internal TLS secrets (applied on each app's next deploy) =="
  local d="$TLS_DIR"
  if ! stage_secrets "$DB_APP" \
    "DB_TLS_CERT_B64=${d}/db-server.crt" \
    "DB_TLS_KEY_B64=${d}/db-server.key" \
    "DB_TLS_CLIENT_CA_B64=${d}/ca.crt"; then
    echo "$RERUN_MESSAGE" >&2
    exit 1
  fi
  if ! stage_secrets "$API_APP" \
    "API_TLS_CERT_B64=${d}/api-server.crt" \
    "API_TLS_KEY_B64=${d}/api-server.key" \
    "API_TLS_CLIENT_CA_B64=${d}/ca.crt" \
    "DATABASE_TLS_CA_B64=${d}/ca.crt" \
    "DATABASE_TLS_CLIENT_CERT_B64=${d}/api-db-client.crt" \
    "DATABASE_TLS_CLIENT_KEY_B64=${d}/api-db-client.key"; then
    echo "$RERUN_MESSAGE" >&2
    exit 1
  fi
  if ! stage_secrets "$WEB_APP" \
    "API_TLS_CA_B64=${d}/ca.crt" \
    "API_TLS_CLIENT_CERT_B64=${d}/web-client.crt" \
    "API_TLS_CLIENT_KEY_B64=${d}/web-client.key"; then
    echo "$RERUN_MESSAGE" >&2
    exit 1
  fi
  echo "Staged: ${DB_APP} (3), ${API_APP} (6), ${WEB_APP} (3). Deploy db -> api -> web next."
}

cmd_issue_operator() {
  parse_out "$@"
  [[ -d "$OUT_DIR" ]] || { echo "${OUT_DIR} does not exist (the caller owns and removes it)" >&2; exit 1; }
  TLS_DIR="$(mktemp -d)"
  trap 'rm -rf "$TLS_DIR"' EXIT
  load_ca "$TLS_DIR"
  write_ext "${TLS_DIR}/operator.ext" clientAuth
  new_ec_key_and_csr "${TLS_DIR}/operator" "/CN=fly-operator"
  sign_leaf "${TLS_DIR}/operator" "$TLS_DIR" "$OPERATOR_DAYS" "${TLS_DIR}/operator.ext"
  verify_leaf "${TLS_DIR}/operator" "$TLS_DIR"
  install -m 0600 "${TLS_DIR}/operator.key" "${OUT_DIR}/operator.key"
  install -m 0644 "${TLS_DIR}/operator.crt" "${OUT_DIR}/operator.crt"
  install -m 0644 "${TLS_DIR}/ca.crt" "${OUT_DIR}/ca.crt"
  echo "== Operator client certificate issued (${OPERATOR_DAYS} day) =="
  describe_cert "operator" "${OUT_DIR}/operator.crt"
}

main() {
  local subcommand="${1:-}"
  [[ -n "$subcommand" ]] || usage
  shift
  case "$subcommand" in
    init-ca) require_openssl; cmd_init_ca "$@" ;;
    issue-leaves) require_openssl; cmd_issue_leaves "$@" ;;
    issue-operator) require_openssl; cmd_issue_operator "$@" ;;
    *) usage ;;
  esac
}

main "$@"
