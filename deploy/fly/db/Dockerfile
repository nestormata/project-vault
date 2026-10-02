# Fly.io demo Postgres (Story 43.16): the stock postgres:16-alpine image — the same tag as
# docker-compose.yml, CI and the image fly.db.toml used before, so the major version and the
# existing data volume stay compatible — plus TLS 1.3 with a private CA and client-certificate
# authentication for every network connection. Fly-only: docker-compose keeps the stock image.
# Build context is the repo root (`flyctl deploy -c fly.db.toml`).
# Named `runner` so the nightly/PR image scans (Story 43.16 AC-13) build it with an explicit
# --target, like every other scanned image.
# Story 64.6: the base is pinned by the multi-arch INDEX digest of `postgres:16-alpine` (a bare
# digest, Sonar S8431-clean, same form as node). The weekly base-image-refresh workflow keeps it
# current (scripts/refresh-base-image.sh --image postgres) and the guard
# scripts/check-base-image-digest.test.ts rejects a floating tag here.
FROM postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777 AS runner

# The stock entrypoint drops root with gosu, a Go binary whose bundled stdlib carries fixable
# HIGH/CRITICAL CVEs that the image scan gate blocks on (Story 43.16 AC-13). su-exec (Alpine's small
# C tool, same `<user> <command...>` interface, and what the Alpine postgres images used before
# gosu) replaces it under the same command name, so docker-entrypoint.sh is unchanged. The Go
# binary is deleted (a layer whiteout, which image scanners honour) and the su-exec link lives at
# /usr/local/sbin/gosu, which is on PATH. There is deliberately no `apk upgrade`: OS fixes arrive
# through the reviewed digest refresh, so a build never drifts from its pin (Story 64.6; on the
# pinned digest `apk upgrade` changed no package and the Trivy gate was clean without it).
RUN apk add --no-cache su-exec \
 && rm -f /usr/local/bin/gosu \
 && mkdir -p /usr/local/sbin \
 && ln -s /sbin/su-exec /usr/local/sbin/gosu

COPY deploy/fly/db/pg_hba.conf /etc/postgresql/pg_hba.conf
COPY deploy/fly/db/entrypoint-tls.sh /usr/local/bin/entrypoint-tls.sh
RUN chmod 0644 /etc/postgresql/pg_hba.conf \
 && chmod 0755 /usr/local/bin/entrypoint-tls.sh

# Runs as root (like the stock entrypoint) to write the TLS files with postgres ownership, then
# execs the stock docker-entrypoint.sh, which drops to the postgres user.
ENTRYPOINT ["/usr/local/bin/entrypoint-tls.sh"]
