# node:24-alpine, pinned by digest for reproducibility (Sonar S8431: tag + digest together
# is redundant since the digest alone already fixes the exact image).
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

RUN npm install -g pnpm@11.9.0
# argon2 (packages/crypto) is a native module. node-gyp-build falls back to compiling
# from source when no bundled prebuild matches this platform, so these tools are
# installed unconditionally rather than detected at build time (Story 1.5 AC-30).
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/agent/package.json ./packages/agent/
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/crypto ./packages/crypto
COPY packages/agent ./packages/agent
COPY packages/eslint-config ./packages/eslint-config

# Split off from the final `builder` stage (Story 1.13 AC-D1) so the one-shot `migrate` service
# (docker-compose.yml) doesn't have to build `agent`/`api` just to run a migration. `crypto` is
# required here — NOT skippable — because packages/db/tsconfig.json compiles all of src/** with
# no per-file exclusions, and schema/pending-imports.ts + schema/credential-versions.ts import
# type EncryptedValue from @project-vault/crypto; omitting crypto's build fails db's build with
# TS2307 (verified empirically — do not regress to a shared+db-only RUN here).
FROM builder AS db-builder
RUN pnpm --filter @project-vault/shared build \
 && pnpm --filter @project-vault/crypto build \
 && pnpm --filter @project-vault/db build

# Extends db-builder (already has shared+crypto+db built) with the two remaining packages
# (Story 1.13 AC-D2) — same cumulative filesystem as the original single 5-package RUN, just
# produced across two stages so `migrate` (targeting db-builder) never waits on these two.
FROM db-builder AS builder
RUN pnpm --filter @project-vault/agent build \
 && pnpm --filter @project-vault/api build

# Bundle the api and its production deps into a self-contained directory. This runs in its
# own stage (not in `builder`) because `pnpm deploy` prunes the workspace node_modules to
# production-only in place — the `migrate` service targets `db-builder` directly (Story 1.13
# AC-D3) to run drizzle-kit, and a pruned workspace there made pnpm's automatic deps-status
# check try to self-heal via `pnpm install --production`, which fails on the root
# `prepare: husky` script (a devDependency absent from a production install).
# pnpm deploy copies from the already-built virtual store (argon2 native binary included)
# so no compiler toolchain is needed in the runner stage.
FROM builder AS deploy
RUN pnpm --filter @project-vault/api deploy --prod --legacy /app/deploy

# node:24-alpine, pinned by digest — see builder stage comment above.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner

RUN apk add --no-cache curl
# Story 9.1 D4/AC-17: pg_dump/pg_restore/psql for encrypted backup & restore — postgresql16-client
# matches the pinned postgres:16-alpine server version in docker-compose.yml (pg_dump's major
# version must match or exceed the server's). Available in Alpine's package repo for both AMD64
# and ARM64 (NFR-MAINT5 multi-arch builds).
RUN apk add --no-cache postgresql16-client
# npm/npx are never invoked at runtime (CMD runs node directly) — dropping them
# removes their bundled deps (e.g. undici) as a source of image CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=deploy --chown=node:node /app/deploy .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node

CMD ["node", "dist/main.js"]
