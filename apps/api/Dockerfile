FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS builder

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
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/crypto ./packages/crypto
COPY packages/eslint-config ./packages/eslint-config

WORKDIR /app
RUN pnpm --filter @project-vault/shared build \
 && pnpm --filter @project-vault/db build \
 && pnpm --filter @project-vault/crypto build \
 && pnpm --filter @project-vault/api build

# Bundle the api and its production deps into a self-contained directory.
# pnpm deploy copies from the already-built virtual store (argon2 native binary included)
# so no compiler toolchain is needed in the runner stage.
RUN pnpm --filter @project-vault/api deploy --prod --legacy /app/deploy

FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runner

RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder /app/deploy .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
