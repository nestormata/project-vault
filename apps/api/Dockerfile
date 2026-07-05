FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

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

WORKDIR /app
RUN pnpm --filter @project-vault/shared build \
 && pnpm --filter @project-vault/crypto build \
 && pnpm --filter @project-vault/db build \
 && pnpm --filter @project-vault/agent build \
 && pnpm --filter @project-vault/api build

# Bundle the api and its production deps into a self-contained directory.
# pnpm deploy copies from the already-built virtual store (argon2 native binary included)
# so no compiler toolchain is needed in the runner stage.
RUN pnpm --filter @project-vault/api deploy --prod --legacy /app/deploy

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner

RUN apk add --no-cache curl
# npm/npx are never invoked at runtime (CMD runs node directly) — dropping them
# removes their bundled deps (e.g. undici) as a source of image CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=builder --chown=node:node /app/deploy .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node

CMD ["node", "dist/main.js"]
