#!/usr/bin/env bash
# Story 64.4/64.6: base-image digest refresh helper, driven by .github/workflows/base-image-refresh.yml.
#
#   images                    print the image families this script can refresh, one per line
#   current [ROOT]            print the one sha256 digest all of the image's `FROM` lines share
#   rewrite DIGEST [ROOT]     rewrite every `FROM <image>@sha256:`/`FROM <image>:<tag>@sha256:` line
#   resolve                   print the registry's current index digest for the image's tag
#   verify OLD NEW            fail if NEW ships an older libssl3 than OLD on any arch; prints a
#                             markdown report of the Alpine / libssl3 / libcrypto3 versions
#   version-ge A B            exit 0 when apk version A >= B (the rollback comparison)
#
# Every command except `images` and `version-ge` takes `--image node|postgres` (default node).
# The image table lives in select_image(); scripts/check-base-image-digest.test.ts fails when a
# pinned image family is missing from it. The pin stays a bare digest (Sonar S8431); this script
# never adds a tag. Needs bash, curl, jq, tar, sed, grep and `sort -V` only, so it runs on a stock
# ubuntu runner with no extra action.
set -euo pipefail

IMAGE_NAMES=(node postgres)
IMAGE=node
DIGEST_RE='^sha256:[0-9a-f]{64}$'
INDEX_ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
MANIFEST_ACCEPT='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
HTTPS_ONLY='=https'
CURL_HTTPS=(--proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY")

die() {
  echo "refresh-base-image: $*" >&2
  exit 1
}

# Image table: registry repo, tracked tag and the Dockerfiles that pin it.
select_image() {
  case "$IMAGE" in
    node)
      REPO="library/node"
      TAG="${BASE_IMAGE_TAG:-24-alpine}"
      FILES=(apps/api/Dockerfile apps/web/Dockerfile Dockerfile.ci)
      ;;
    postgres)
      REPO="library/postgres"
      TAG="${POSTGRES_IMAGE_TAG:-16-alpine}"
      FILES=(deploy/fly/db/Dockerfile)
      ;;
    *) die "unknown image '$IMAGE' (known: ${IMAGE_NAMES[*]})" ;;
  esac
  REGISTRY="https://registry-1.docker.io/v2/${REPO}"
  # Same FROM shapes the guard accepts: any case, optional leading --flag options (--platform=...).
  FROM_PREFIX="^FROM( --[^[:space:]]+)* ${IMAGE}(:[^@[:space:]]+)?@"
  FROM_RE="${FROM_PREFIX}sha256:[0-9a-f]{64}"
}

require_digest() {
  local candidate="$1"
  [[ "$candidate" =~ $DIGEST_RE ]] || die "not a sha256 digest: '$candidate'"
}

cmd_images() {
  printf '%s\n' "${IMAGE_NAMES[@]}"
}

cmd_current() {
  local root="${1:-.}" file line
  local found=()
  for file in "${FILES[@]}"; do
    [[ -f "$root/$file" ]] || die "missing $root/$file"
    while IFS= read -r line; do
      found+=("$(grep -Eo 'sha256:[0-9a-f]{64}' <<<"$line")")
    done < <(grep -Ei "$FROM_RE" "$root/$file" || true)
  done
  [[ ${#found[@]} -gt 0 ]] || die "no FROM ${IMAGE}@sha256 lines found"
  local unique
  unique=$(printf '%s\n' "${found[@]}" | sort -u)
  [[ $(wc -l <<<"$unique") -eq 1 ]] || die "$IMAGE FROM lines pin more than one digest: $(tr '\n' ' ' <<<"$unique")"
  echo "$unique"
}

cmd_rewrite() {
  local new="${1:-}" root="${2:-.}" file count total=0
  require_digest "$new"
  for file in "${FILES[@]}"; do
    [[ -f "$root/$file" ]] || die "missing $root/$file"
    count=$(grep -Eic "$FROM_RE" "$root/$file" || true)
    [[ "$count" -gt 0 ]] || die "$file has no FROM ${IMAGE}@sha256 line to rewrite"
    sed -E -i "s#(${FROM_PREFIX})sha256:[0-9a-f]{64}#\\1${new}#I" "$root/$file"
    total=$((total + count))
  done
  echo "rewrote $total FROM lines to $new"
}

token() {
  curl -fsS "${CURL_HTTPS[@]}" "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull" | jq -r .token
}

cmd_resolve() {
  local t digest
  t=$(token)
  digest=$(curl -fsSI "${CURL_HTTPS[@]}" -H "Authorization: Bearer $t" -H "Accept: $INDEX_ACCEPT" "$REGISTRY/manifests/$TAG" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}')
  require_digest "$digest"
  echo "$digest"
}

# Prints "<alpine-release> <libssl3> <libcrypto3>" for one platform of an index digest.
base_versions() {
  local t="$1" index="$2" arch="$3" manifest layer tmp alpine db ssl crypto
  manifest=$(curl -fsS "${CURL_HTTPS[@]}" -H "Authorization: Bearer $t" -H "Accept: $INDEX_ACCEPT" "$REGISTRY/manifests/$index" \
    | jq -r --arg a "$arch" '.manifests[] | select(.platform.architecture==$a and .platform.os=="linux") | .digest' | head -n1)
  [[ -n "$manifest" ]] || die "no $arch manifest in $index"
  layer=$(curl -fsS "${CURL_HTTPS[@]}" -H "Authorization: Bearer $t" -H "Accept: $MANIFEST_ACCEPT" "$REGISTRY/manifests/$manifest" | jq -r '.layers[0].digest')
  tmp=$(mktemp)
  curl -fsSL --proto "$HTTPS_ONLY" --proto-redir '=https' -H "Authorization: Bearer $t" "$REGISTRY/blobs/$layer" -o "$tmp"
  alpine=$(tar -xzOf "$tmp" etc/alpine-release)
  # Read the package db once and let awk consume all of it: an early `exit` would SIGPIPE tar and,
  # under `set -o pipefail`, abort the script nondeterministically.
  db=$(tar -xzOf "$tmp" lib/apk/db/installed)
  rm -f "$tmp"
  ssl=$(awk '/^P:libssl3$/{p=1;next} p&&/^V:/{print substr($0,3);p=0}' <<<"$db" | head -n1)
  crypto=$(awk '/^P:libcrypto3$/{p=1;next} p&&/^V:/{print substr($0,3);p=0}' <<<"$db" | head -n1)
  [[ -n "$alpine" && -n "$ssl" && -n "$crypto" ]] || die "could not read versions for $arch of $index"
  echo "$alpine $ssl $crypto"
}

# True (exit 0) when version $1 is >= version $2 (apk -rN revisions sort correctly with sort -V).
version_ge() {
  local candidate="$1" floor="$2"
  [[ "$(printf '%s\n%s\n' "$candidate" "$floor" | sort -V | head -n1)" == "$floor" ]]
}

cmd_verify() {
  local old="${1:-}" new="${2:-}" t arch o n oa os na ns nc
  require_digest "$old"
  require_digest "$new"
  t=$(token)
  echo "| arch | old (Alpine / libssl3) | new (Alpine / libssl3 / libcrypto3) |"
  echo "| --- | --- | --- |"
  for arch in amd64 arm64; do
    o=$(base_versions "$t" "$old" "$arch")
    n=$(base_versions "$t" "$new" "$arch")
    read -r oa os _ <<<"$o"
    read -r na ns nc <<<"$n"
    version_ge "$ns" "$os" || die "$IMAGE $arch: new libssl3 $ns is OLDER than current $os (registry rollback?); refusing to refresh"
    echo "| $arch | $oa / $os | $na / $ns / $nc |"
  done
}

# `--image NAME` may appear anywhere after the command.
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      [[ $# -ge 2 ]] || die "--image needs a value (${IMAGE_NAMES[*]})"
      IMAGE="$2"
      shift 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift

case "$COMMAND" in
  images) cmd_images ;;
  version-ge)
    version_ge "${1:-}" "${2:-}"
    ;;
  current | rewrite | resolve | verify)
    select_image
    "cmd_${COMMAND}" "$@"
    ;;
  *) die "usage: $0 {images|version-ge A B|current [ROOT]|rewrite DIGEST [ROOT]|resolve|verify OLD NEW} [--image node|postgres]" ;;
esac
