FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS builder

RUN npm install -g pnpm@11.5.0

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --frozen-lockfile

COPY apps/web ./apps/web
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config

WORKDIR /app/apps/web
RUN pnpm build

FROM node:24-alpine@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runner

RUN npm install -g pnpm@11.5.0 && npm cache clean --force
RUN apk add --no-cache curl

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/packages/tsconfig/package.json ./packages/tsconfig/
COPY --from=builder /app/packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
 && rm -rf /root/.cache/pnpm /root/.local/share/pnpm /root/.npm

COPY --from=builder /app/apps/web/build ./apps/web/build

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

WORKDIR /app/apps/web
CMD ["node", "build"]
