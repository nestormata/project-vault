#!/usr/bin/env bash
# Story 64.4: base-image digest refresh helper, driven by .github/workflows/base-image-refresh.yml.
#
#   current [ROOT]            print the one sha256 digest all `FROM node@sha256:` lines share
#   rewrite DIGEST [ROOT]     rewrite every `FROM node@sha256:`/`FROM node:<tag>@sha256:` line
#   resolve                   print the registry's current node:24-alpine index digest
#   verify OLD NEW            fail if NEW ships an older libssl3 than OLD on any arch; prints a
#                             markdown report of the Alpine / libssl3 / libcrypto3 versions
#
# The pin stays a bare digest (Sonar S8431); this script never adds a tag. Needs bash, curl, jq,
# tar, sed, grep and `sort -V` only, so it runs on a stock ubuntu runner with no extra action.
set -euo pipefail

TAG="${BASE_IMAGE_TAG:-24-alpine}"
REGISTRY="https://registry-1.docker.io/v2/library/node"
FILES=(apps/api/Dockerfile apps/web/Dockerfile Dockerfile.ci)
DIGEST_RE='^sha256:[0-9a-f]{64}$'
FROM_RE='^FROM node(:[^@[:space:]]+)?@sha256:[0-9a-f]{64}'
INDEX_ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
MANIFEST_ACCEPT='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

die() {
  echo "refresh-base-image: $*" >&2
  exit 1
}

require_digest() {
  [[ "$1" =~ $DIGEST_RE ]] || die "not a sha256 digest: '$1'"
}

cmd_current() {
  local root="${1:-.}" file line
  local found=()
  for file in "${FILES[@]}"; do
    [[ -f "$root/$file" ]] || die "missing $root/$file"
    while IFS= read -r line; do
      found+=("$(grep -Eo 'sha256:[0-9a-f]{64}' <<<"$line")")
    done < <(grep -E "$FROM_RE" "$root/$file" || true)
  done
  [[ ${#found[@]} -gt 0 ]] || die "no FROM node@sha256 lines found"
  local unique
  unique=$(printf '%s\n' "${found[@]}" | sort -u)
  [[ $(wc -l <<<"$unique") -eq 1 ]] || die "FROM lines pin more than one digest: $(tr '\n' ' ' <<<"$unique")"
  echo "$unique"
}

cmd_rewrite() {
  local new="${1:-}" root="${2:-.}" file count total=0
  require_digest "$new"
  for file in "${FILES[@]}"; do
    [[ -f "$root/$file" ]] || die "missing $root/$file"
    count=$(grep -Ec "$FROM_RE" "$root/$file" || true)
    [[ "$count" -gt 0 ]] || die "$file has no FROM node@sha256 line to rewrite"
    sed -E -i "s#^(FROM node(:[^@[:space:]]+)?@)sha256:[0-9a-f]{64}#\\1${new}#" "$root/$file"
    total=$((total + count))
  done
  echo "rewrote $total FROM lines to $new"
}

token() {
  curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token
}

cmd_resolve() {
  local t digest
  t=$(token)
  digest=$(curl -fsSI -H "Authorization: Bearer $t" -H "Accept: $INDEX_ACCEPT" "$REGISTRY/manifests/$TAG" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}')
  require_digest "$digest"
  echo "$digest"
}

# Prints "<alpine-release> <libssl3> <libcrypto3>" for one platform of an index digest.
base_versions() {
  local t="$1" index="$2" arch="$3" manifest layer tmp alpine ssl crypto
  manifest=$(curl -fsS -H "Authorization: Bearer $t" -H "Accept: $INDEX_ACCEPT" "$REGISTRY/manifests/$index" \
    | jq -r --arg a "$arch" '.manifests[] | select(.platform.architecture==$a and .platform.os=="linux") | .digest' | head -n1)
  [[ -n "$manifest" ]] || die "no $arch manifest in $index"
  layer=$(curl -fsS -H "Authorization: Bearer $t" -H "Accept: $MANIFEST_ACCEPT" "$REGISTRY/manifests/$manifest" | jq -r '.layers[0].digest')
  tmp=$(mktemp)
  curl -fsSL -H "Authorization: Bearer $t" "$REGISTRY/blobs/$layer" -o "$tmp"
  alpine=$(tar -xzOf "$tmp" etc/alpine-release)
  ssl=$(tar -xzOf "$tmp" lib/apk/db/installed | awk '/^P:libssl3$/{p=1;next} p&&/^V:/{print substr($0,3);exit}')
  crypto=$(tar -xzOf "$tmp" lib/apk/db/installed | awk '/^P:libcrypto3$/{p=1;next} p&&/^V:/{print substr($0,3);exit}')
  rm -f "$tmp"
  [[ -n "$alpine" && -n "$ssl" && -n "$crypto" ]] || die "could not read versions for $arch of $index"
  echo "$alpine $ssl $crypto"
}

# True (exit 0) when version $1 is >= version $2 (apk -rN revisions sort correctly with sort -V).
version_ge() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]
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
    version_ge "$ns" "$os" || die "$arch: new libssl3 $ns is OLDER than current $os (registry rollback?); refusing to refresh"
    echo "| $arch | $oa / $os | $na / $ns / $nc |"
  done
}

case "${1:-}" in
  current) shift; cmd_current "$@" ;;
  rewrite) shift; cmd_rewrite "$@" ;;
  resolve) shift; cmd_resolve "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  *) die "usage: $0 {current [ROOT]|rewrite DIGEST [ROOT]|resolve|verify OLD NEW}" ;;
esac
