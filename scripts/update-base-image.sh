#!/usr/bin/env bash
set -euo pipefail

# Pulls node:24-alpine and gets its digest for Dockerfile pinning
# Run weekly and update Dockerfiles with the new digest

IMAGE="node:24-alpine"
echo "Pulling ${IMAGE}..."
docker pull "${IMAGE}"

DIGEST=$(docker inspect "${IMAGE}" --format='{{index .RepoDigests 0}}')
echo "Current digest: ${DIGEST}"
echo ""
echo "Update your Dockerfiles to use:"
echo "FROM ${DIGEST}"
