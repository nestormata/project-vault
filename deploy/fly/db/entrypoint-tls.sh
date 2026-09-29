#!/usr/bin/env bash
# Fly demo Postgres entrypoint (Story 43.16 AC-4): decodes the TLS material staged by
# scripts/fly-internal-tls.sh into files Postgres can read, then hands over to the stock
# docker-entrypoint.sh with TLS 1.3 and the client-certificate pg_hba.conf.
#
# Fails closed: every DB_TLS_* variable is required (this image is Fly-only). The values are never
# echoed, and they are removed from the environment before Postgres starts.
set -euo pipefail

: "${DB_TLS_CERT_B64:?DB_TLS_CERT_B64 is required (server certificate, base64 PEM; see docs/runbooks/fly-internal-tls.md)}"
: "${DB_TLS_KEY_B64:?DB_TLS_KEY_B64 is required (server private key, base64 PEM; see docs/runbooks/fly-internal-tls.md)}"
: "${DB_TLS_CLIENT_CA_B64:?DB_TLS_CLIENT_CA_B64 is required (CA client certificates must chain to; see docs/runbooks/fly-internal-tls.md)}"

TLS_DIR=/etc/postgresql/tls
umask 077
mkdir -p "$TLS_DIR"

# decode <VAR_NAME> <destination>: base64 -> PEM file, checked for a PEM header. Messages name the
# variable only.
decode() {
  local name="$1" destination="$2"
  if ! printf '%s' "${!name}" | base64 -d >"$destination" 2>/dev/null; then
    echo "entrypoint-tls: ${name} is not valid base64" >&2
    exit 1
  fi
  if ! grep -q -- '-----BEGIN' "$destination"; then
    echo "entrypoint-tls: ${name} is not base64 of a PEM document" >&2
    exit 1
  fi
}

decode DB_TLS_CERT_B64 "${TLS_DIR}/server.crt"
decode DB_TLS_KEY_B64 "${TLS_DIR}/server.key"
decode DB_TLS_CLIENT_CA_B64 "${TLS_DIR}/ca.crt"
unset DB_TLS_CERT_B64 DB_TLS_KEY_B64 DB_TLS_CLIENT_CA_B64

# Postgres refuses a group- or world-readable key; it runs as the postgres user.
chown postgres:postgres "${TLS_DIR}" "${TLS_DIR}/server.crt" "${TLS_DIR}/server.key" "${TLS_DIR}/ca.crt"
chmod 0700 "${TLS_DIR}"
chmod 0600 "${TLS_DIR}/server.key"
chmod 0644 "${TLS_DIR}/server.crt" "${TLS_DIR}/ca.crt"

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file="${TLS_DIR}/server.crt" \
  -c ssl_key_file="${TLS_DIR}/server.key" \
  -c ssl_ca_file="${TLS_DIR}/ca.crt" \
  -c ssl_min_protocol_version=TLSv1.3 \
  -c hba_file=/etc/postgresql/pg_hba.conf \
  "$@"
