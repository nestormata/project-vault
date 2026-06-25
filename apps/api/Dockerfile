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

FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runner

RUN npm install -g pnpm@11.9.0 && npm cache clean --force
RUN apk add --no-cache curl python3 make g++

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/packages/tsconfig/package.json ./packages/tsconfig/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/db/package.json ./packages/db/
COPY --from=builder /app/packages/crypto/package.json ./packages/crypto/
COPY --from=builder /app/packages/eslint-config/package.json ./packages/eslint-config/

# --ignore-scripts skips the root "prepare" (husky) script, which isn't available in a
# --prod install. argon2's native binary still needs its own install script to run, so
# `pnpm rebuild argon2` triggers just that one afterward (Story 1.5 AC-30).
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
 && pnpm rebuild argon2 \
 && rm -rf /root/.cache/pnpm /root/.local/share/pnpm /root/.npm \
 && apk del python3 make g++

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/crypto/dist ./packages/crypto/dist

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
