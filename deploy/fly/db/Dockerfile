# Fly.io demo Postgres (Story 43.16): the stock postgres:16-alpine image — the same tag as
# docker-compose.yml, CI and the image fly.db.toml used before, so the major version and the
# existing data volume stay compatible — plus TLS 1.3 with a private CA and client-certificate
# authentication for every network connection. Fly-only: docker-compose keeps the stock image.
# Build context is the repo root (`flyctl deploy -c fly.db.toml`).
FROM postgres:16-alpine

COPY deploy/fly/db/pg_hba.conf /etc/postgresql/pg_hba.conf
COPY deploy/fly/db/entrypoint-tls.sh /usr/local/bin/entrypoint-tls.sh
RUN chmod 0644 /etc/postgresql/pg_hba.conf \
 && chmod 0755 /usr/local/bin/entrypoint-tls.sh

# Runs as root (like the stock entrypoint) to write the TLS files with postgres ownership, then
# execs the stock docker-entrypoint.sh, which drops to the postgres user.
ENTRYPOINT ["/usr/local/bin/entrypoint-tls.sh"]
