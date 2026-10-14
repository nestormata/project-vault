# Story 68.29 (DW-506, Story 68.10 AC-2.10): the one signature list that decides whether a failed
# registry / image-pull step may be retried once. Sourced by scripts/e2e-stack.sh (compose up
# --build) and scripts/web-host-consumer-fixture/run.sh (npm install). Never used for the
# Playwright run, a lockfile mismatch, a build error or a host-port collision: those have no
# signature here, so they fail on the first attempt.
#
#   is_transient_network_error <file>   exit 0 when <file> holds a transient network signature
readonly TRANSIENT_NETWORK_RETRY_DELAY_SECONDS="${TRANSIENT_NETWORK_RETRY_DELAY_SECONDS:-15}"

is_transient_network_error() {
  grep -Eiq \
    'TLS handshake timeout|i/o timeout|connection reset|unexpected EOF|toomanyrequests|ETIMEDOUT|ECONNRESET|EAI_AGAIN|failed to resolve source metadata|(received unexpected HTTP status|error response from daemon|status code|HTTP)[^a-z]{0,12}50[234]|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)' \
    -- "$1"
}
