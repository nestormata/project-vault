#!/usr/bin/env bash
set -euo pipefail

# Pulls node:24-alpine and prints its digest, for a manual look at the local image.
# Normal refreshes are automated (Story 64.4): .github/workflows/base-image-refresh.yml opens a PR
# weekly (run it on demand with `gh workflow run base-image-refresh.yml`), using
# scripts/refresh-base-image.sh to rewrite every `FROM node@sha256:` line. Prefer that over editing
# the Dockerfiles by hand.

IMAGE="node:24-alpine"
echo "Pulling ${IMAGE}..."
docker pull "${IMAGE}"

DIGEST=$(docker inspect "${IMAGE}" --format='{{index .RepoDigests 0}}')
echo "Current digest: ${DIGEST}"
echo ""
echo "Update your Dockerfiles to use:"
echo "FROM ${DIGEST}"
