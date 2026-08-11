# node:24-alpine, pinned by digest for reproducibility (Sonar S8431: tag + digest together
# is redundant since the digest alone already fixes the exact image).
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

RUN npm install -g pnpm@11.9.0 --ignore-scripts
# argon2 (packages/crypto) is a native module. node-gyp-build falls back to compiling
# from source when no bundled prebuild matches this platform, so these tools are
# installed unconditionally rather than detected at build time (Story 1.5 AC-30).
RUN apk add --no-cache g++ make python3

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/agent/package.json ./packages/agent/
COPY packages/extension-api/package.json ./packages/extension-api/
COPY packages/eslint-config/package.json ./packages/eslint-config/
# Story 14.3 Task 10: @project-vault/mock-sso-extension is a devDependency of apps/api (never a
# production dep — see fixtures/mock-sso-extension/README.md's "Production-safety" section) but
# is a real pnpm-workspace member present in pnpm-lock.yaml; `pnpm install --frozen-lockfile`
# fails without its package.json regardless of whether this build ever deploys it (verified
# empirically — same "Docker only builds what's explicitly listed" gotcha as extension-api's own
# comment above).
COPY fixtures/mock-sso-extension/package.json ./fixtures/mock-sso-extension/

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm rebuild argon2 esbuild

COPY apps/api ./apps/api
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/crypto ./packages/crypto
COPY packages/agent ./packages/agent
COPY packages/extension-api ./packages/extension-api
COPY packages/eslint-config ./packages/eslint-config
COPY fixtures/mock-sso-extension ./fixtures/mock-sso-extension

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

# Extends db-builder (already has shared+crypto+db built) with the remaining packages
# (Story 1.13 AC-D2) — same cumulative filesystem as the original single 5-package RUN, just
# produced across two stages so `migrate` (targeting db-builder) never waits on these.
# extension-api has no workspace-internal dependencies (Story 14.1) and apps/api imports it
# directly (Story 14.2) — must be built before @project-vault/api or its build fails with
# TS2307 "Cannot find module '@project-vault/extension-api'" (verified empirically — this
# package was previously missing from the Dockerfile entirely, only caught by CI, not local
# `make ci`, since pnpm's local workspace symlinks resolve it without a dist build).
# Named app-builder, not builder: BuildKit's DuplicateStageName check now flags redeclaring an
# earlier stage name even though position-based FROM resolution made this unambiguous (every
# reference to `builder` above this line, e.g. db-builder's own `FROM builder`, correctly bound
# to the original stage at line 3).
FROM db-builder AS app-builder
RUN pnpm --filter @project-vault/agent build \
 && pnpm --filter @project-vault/extension-api build \
 && pnpm --filter @project-vault/api build

# Story 14.3 Task 10: build the mock external-IdP fixture ONLY when explicitly opted in (default
# false) — this is never set for `make docker-up`/`make docker-prod`'s default build, only for the
# e2e-specific build (docker-compose.e2e.yml's `build.args` override, same
# never-in-the-base-compose-file precedent as its `VAULT_EXTENSIONS_PACKAGE` env var).
ARG INCLUDE_MOCK_SSO_EXTENSION=false
RUN if [ "$INCLUDE_MOCK_SSO_EXTENSION" = "true" ]; then pnpm --filter @project-vault/mock-sso-extension build; fi

# Bundle the api and its production deps into a self-contained directory. This runs in its
# own stage (not in `app-builder`) because `pnpm deploy` prunes the workspace node_modules to
# production-only in place — the `migrate` service targets `db-builder` directly (Story 1.13
# AC-D3) to run drizzle-kit, and a pruned workspace there made pnpm's automatic deps-status
# check try to self-heal via `pnpm install --production`, which fails on the root
# `prepare: husky` script (a devDependency absent from a production install).
# pnpm deploy copies from the already-built virtual store (argon2 native binary included)
# so no compiler toolchain is needed in the runner stage.
FROM app-builder AS deploy
ARG INCLUDE_MOCK_SSO_EXTENSION=false
RUN pnpm --filter @project-vault/api deploy --prod --legacy /app/deploy
# `pnpm deploy --prod` always prunes devDependencies — that's the correct, desired behavior for
# every default/production build (the mock extension must never ship there). When explicitly
# opted in for e2e, manually graft the already-built fixture into the deployed node_modules so
# apps/api's extension loader (a plain `import(packageName)` by name) can resolve it at runtime.
RUN if [ "$INCLUDE_MOCK_SSO_EXTENSION" = "true" ]; then \
      mkdir -p /app/deploy/node_modules/@project-vault/mock-sso-extension && \
      cp -r /app/fixtures/mock-sso-extension/dist /app/deploy/node_modules/@project-vault/mock-sso-extension/dist && \
      cp /app/fixtures/mock-sso-extension/package.json /app/deploy/node_modules/@project-vault/mock-sso-extension/package.json; \
    fi

# node:24-alpine, pinned by digest — see builder stage comment above.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner

# Story 9.1 D4/AC-17: pg_dump/pg_restore/psql for encrypted backup & restore — postgresql16-client
# matches the pinned postgres:16-alpine server version in docker-compose.yml (pg_dump's major
# version must match or exceed the server's). Available in Alpine's package repo for both AMD64
# and ARM64 (NFR-MAINT5 multi-arch builds).
# npm/npx are never invoked at runtime (CMD runs node directly) — dropping them
# removes their bundled deps (e.g. undici) as a source of image CVEs.
# Story 9.9: su-exec lets docker-entrypoint.sh drop from root to the non-root `node` user right
# before exec'ing the app (see that script's own comment) — the minimal, purpose-built tool for
# this, unlike `gosu` (bigger) or `sudo` (not in Alpine's base repo, broader privilege model than
# needed here).
RUN apk add --no-cache curl postgresql16-client su-exec \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=deploy --chown=node:node /app/deploy .

# Story 9.9: root-owned (not --chown=node:node) — it needs to run as root briefly to chown the
# backup destination before dropping privileges; see the script's own header comment.
COPY apps/api/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Story 9.10 AC-1/AC-2: build-time-injected release identity — sourced from the release tag by
# .github/workflows/container-publish.yml (RELEASE_VERSION=${{ needs.prepare.outputs.version }}).
# The 'dev' default means any build that doesn't explicitly pass this build-arg (a local
# `docker build`, `make docker-up`, etc.) is unambiguously labeled as a non-release build rather
# than silently carrying no version metadata at all. Exported as a runtime ENV as well as an OCI
# label because this stage's process actually runs the app, and getReleaseVersion()
# (apps/api/src/lib/package-version.ts) reads RELEASE_VERSION from the live process environment
# to serve /health, /status and OpenAPI info.version with no .git/network access.
# Declared LAST in the stage on purpose: RELEASE_VERSION changes on every release, and every
# layer below a referenced ARG is cache-invalidated — putting it above this stage's apk/COPY
# layers would rebuild them on each publish, defeating the workflow's cache-from/cache-to GHA
# cache. For the same reason it must NOT be declared in a stage other stages build FROM (see the
# `migrate` leaf stage at the end of this file).
ARG RELEASE_VERSION=dev
ENV RELEASE_VERSION=$RELEASE_VERSION
LABEL org.opencontainers.image.version=$RELEASE_VERSION

EXPOSE 3000

# Story 9.9: HEALTHCHECK runs using the image's configured user, not whatever the entrypoint
# drops to at runtime — since there's no longer a top-level `USER node`, that default is now
# root. Route the probe itself through `su-exec node` so it runs as the non-root user too; only
# the entrypoint's brief startup window (before `exec su-exec node:node "$@"`) runs as root.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD su-exec node curl -f http://localhost:3000/health || exit 1

# Story 9.9: no top-level `USER node` here anymore — the container starts as root so the
# entrypoint can repair BACKUP_STORAGE_PATH ownership, then drops to `node` itself via
# `su-exec` before exec'ing CMD below. The running application process is still never root;
# the privilege-drop boundary just moved from "image config" to "inside the entrypoint,
# immediately before exec" so it can happen AFTER the narrow chown repair.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]

# Story 9.10 AC-1/AC-2: the `migrate` image's build target. Filesystem-identical to `db-builder`
# (it adds no layer beyond the OCI label) and it never runs the app, so it needs the label only,
# not a runtime ENV. It exists as a separate LEAF stage purely for build caching: RELEASE_VERSION
# changes on every release, so declaring the ARG/LABEL directly in `db-builder` would invalidate
# every layer of the stages that build FROM it (`app-builder` -> `deploy` -> the runner's
# COPY --from=deploy), re-running every `pnpm build` — including the QEMU-emulated linux/arm64
# leg — on each publish. Keeping it in a stage nothing else derives from means the release
# version can only ever bust this one label layer.
FROM db-builder AS migrate
ARG RELEASE_VERSION=dev
LABEL org.opencontainers.image.version=$RELEASE_VERSION
