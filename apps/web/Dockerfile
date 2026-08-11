# node:24-alpine, pinned by digest for reproducibility (Sonar S8431: tag + digest together
# is redundant since the digest alone already fixes the exact image).
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

RUN npm install -g pnpm@11.9.0 --ignore-scripts

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm rebuild esbuild

COPY apps/web ./apps/web
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/eslint-config ./packages/eslint-config

WORKDIR /app/apps/web
RUN pnpm --filter @project-vault/shared build \
 && pnpm build

# Bundle the web app and its production deps into a self-contained directory.
# This keeps pnpm and the full workspace install out of the runtime image.
WORKDIR /app
RUN pnpm --filter @project-vault/web deploy --prod --legacy /app/deploy

# @inlang/paraglide-js declares vite as a runtime dependency (for its `/vite` plugin export,
# used only in vite.config.ts at build time) but its compiled dist/ never requires it — verified
# by grepping the package for any 'vite'/'esbuild' import. adapter-node's build/index.js is
# self-contained and never requires them either. They're pure build-time dead weight here, and
# esbuild's bundled Go toolchain is a recurring source of stdlib CVEs (crypto/tls, net/mail, mime
# — see .trivyignore's history) with no clean fix: esbuild 0.26+ carries a patched Go toolchain
# but breaks this app's SvelteKit build with a destructuring-lowering regression against our Vite
# target (verified 0.27.7 and 0.28.2 both fail identically). Pruning removes the CVE surface
# entirely instead of chasing each new Go stdlib disclosure through .trivyignore.
RUN find /app/deploy/node_modules/.pnpm -maxdepth 1 \( -name 'vite@*' -o -name 'esbuild@*' -o -name '@esbuild+*' \) -exec rm -rf {} +

# node:24-alpine, pinned by digest — see builder stage comment above.
FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner

# npm/npx are never invoked at runtime (CMD runs node directly) — dropping them
# removes their bundled deps (e.g. undici) as a source of image CVEs.
RUN apk add --no-cache curl \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=builder --chown=node:node /app/deploy .

# Story 9.10 AC-1/AC-2: build-time-injected release identity, label only — the web image never
# serves version data itself (Version & Upgrade reads it from the API's /health), so this stage
# only needs the OCI label for image-metadata parity with the api/migrate images, not a runtime
# ENV. Same 'dev' default rationale as apps/api/Dockerfile, and declared after the apk/COPY layers
# for the same cache reason (RELEASE_VERSION changes every release; anything below it rebuilds).
ARG RELEASE_VERSION=dev
LABEL org.opencontainers.image.version=$RELEASE_VERSION

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

USER node

CMD ["node", "build"]
