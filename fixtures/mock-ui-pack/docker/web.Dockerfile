# Story 68.10 AC-2.2: the image of a COMPOSED web app (the pattern CentralizeMe copies, design
# section 12 step 7). The build context is the composed app directory produced by `pv-compose` from
# the PACKED @project-vault/web-host and composition kit tarballs (never `apps/web`, never a
# monorepo path): `package.json` points at ./tarballs/*.tgz, the composed `src/`, `static/`,
# `messages/`, `project.inlang/`, `inlang-plugins/` and `vendor/` are plain copies, and
# `composition.lock.json` is committed beside them. Everything below runs from that context alone.
#
# It replicates PV's apps/web/Dockerfile pruning: after the build, vite, esbuild, lix, binaryen and
# the inlang toolchain are build-time dead weight (paraglide's compiled output never imports them;
# adapter-node's build/index.js is self-contained) and esbuild's Go toolchain is a recurring source
# of image CVEs, so they are removed from the runtime node_modules.
#
# node:24-alpine, pinned by digest like PV's images (Sonar S8431: a digest alone fixes the image).
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /app

# Dependencies first (cached until the manifest or a tarball changes). `file:./tarballs/...` specs
# are the packed web-host, kit and extension-api; every other version is exact.
COPY package.json ./
COPY tarballs ./tarballs
RUN npm install --no-audit --no-fund --ignore-scripts --loglevel=error

COPY . .
RUN node node_modules/@inlang/paraglide-js/bin/run.js compile \
      --project ./project.inlang --outdir ./src/lib/paraglide \
      --strategy cookie baseLocale --emit-ts-declarations --silent \
 && node node_modules/@sveltejs/kit/svelte-kit.js sync \
 && node node_modules/vite/bin/vite.js build --logLevel warn

# Runtime dependencies only, then the same build-time dead-weight pruning as PV's image.
RUN npm prune --omit=dev --ignore-scripts --loglevel=error \
 && rm -rf node_modules/vite node_modules/esbuild node_modules/@esbuild node_modules/@lix-js \
      node_modules/binaryen node_modules/oxc-minify node_modules/@oxc-minify \
      node_modules/@bytecodealliance node_modules/@inlang/sdk

FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner

# npm/npx are never invoked at runtime (CMD runs node directly).
RUN apk add --no-cache curl \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

USER node
CMD ["node", "build"]
