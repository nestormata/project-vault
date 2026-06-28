FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS builder

RUN npm install -g pnpm@11.9.0

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --frozen-lockfile

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

FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runner

RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder --chown=node:node /app/deploy .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

USER node

CMD ["node", "build"]
