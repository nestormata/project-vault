# Reverse proxy and TLS termination

<!-- Verified against apps/api/src/app.ts (trustProxy, CORS), apps/api/src/lib/trust-proxy.ts,
     apps/api/src/config/env.ts (TRUST_PROXY, TRUST_PROXY_HOPS, COOKIE_SECURE,
     CORS_ALLOWED_ORIGINS, WEB_BASE_URL, METRICS_BIND_HOST, ENABLE_API_DOCS),
     apps/api/src/routes/{health,status,metrics}.ts, docker-compose.yml -->

## When to use

Putting this application behind Traefik, nginx, Caddy, or any load balancer — which you must do for
any deployment reachable from outside the host. Neither the API nor the web app terminates TLS
itself.

---

## What to expose, and what never to expose

| Path | Expose publicly? | Why |
| --- | --- | --- |
| The web app (`web`, container port 3000) | Yes | It is the user interface. |
| `/api/v1/**` | Yes | The web app and API clients call it. |
| `GET /health` | Yes, if your uptime checker needs it | Unauthenticated liveness. Returns only `status`, `version`, `versionSource`, and `extensions_status` — no tenant data. |
| `GET /ready` | Yes, for an orchestrator's routing decisions | Unauthenticated readiness. Reveals only `ready`/`sealed`/`uninitialized`/`db` plus two warning names. |
| `GET /status` | **Only with its bearer token** | Aggregate operational status. Without a generated token it is loopback-only and returns a generic `404` to remote callers — do not "fix" that by exposing it; generate a token instead ([`vault-lifecycle.md`](vault-lifecycle.md)). Send the token in an `Authorization: Bearer` header, never a query parameter (proxies log query strings). |
| `GET /metrics` | **Never** | Loopback-bound by default (`METRICS_BIND_HOST=127.0.0.1`) and unauthenticated. Scrape from a same-host or sidecar collector. Publishing it hands out per-route traffic and pool telemetry to anyone. |
| `GET /api/v1/docs`, `GET /api/v1/openapi.json` | **Never in production** | Off by default (`ENABLE_API_DOCS=false`). A browsable map of every authenticated route and schema. If you need it, put it behind the proxy's own auth. |

Explicitly block `/metrics` at the proxy even though the API also refuses it — defence in depth
against a future `METRICS_BIND_HOST` change made for a different reason.

---

## Application configuration

Set these on the API before putting it behind a proxy. All are read once at boot; changing any of
them requires an API restart.

| Variable | Value behind a proxy | Notes |
| --- | --- | --- |
| `TRUST_PROXY` | `true` | Default `false`. Until this is on, the API treats the proxy's own IP as the client address, so rate limiting and the `/status` loopback check see one caller for the whole internet. |
| `TRUST_PROXY_HOPS` | The exact number of proxies in front of the API | Default `1`. The API trusts hop numbers strictly below this value. Count every hop: one Traefik = `1`; a CDN in front of Traefik = `2`. Setting it too high lets a client forge `X-Forwarded-For`; too low makes every request appear to come from your own proxy. |
| `COOKIE_SECURE` | `true` | Defaults to `true` when `NODE_ENV=production`. Session cookies must be `Secure` once TLS terminates upstream — the API cannot detect that on its own. |
| `CORS_ALLOWED_ORIGINS` | The public web origin(s), comma-separated, scheme included — e.g. `https://vault.example.com` | A literal `*` is rejected at boot. This is the exact origin the browser sends, not the API's own hostname. |
| `WEB_BASE_URL` | The same public web origin | Used to build links that leave the application (invitations, recovery emails). A stale value here sends users to the old hostname — a common and confusing post-migration bug. |
| `ENABLE_API_DOCS` | leave unset (`false`) | See the table above. |
| `METRICS_BIND_HOST` | leave `127.0.0.1` | See the table above. |

If you deploy with the checked-in Compose files, set `PUBLIC_WEB_ORIGIN` in `.env` instead of
setting these three separately. Compose feeds that one value to the API's `CORS_ALLOWED_ORIGINS`
and `WEB_BASE_URL` and to the web service's `ORIGIN`, so the three cannot drift apart. Set
`WEB_BASE_URL` explicitly only when outbound links must point somewhere other than the browser
origin. `COOKIE_SECURE`, `TRUST_PROXY` and `TRUST_PROXY_HOPS` pass through from `.env` as well.

After a change, verify from a real browser: sign in, confirm the session survives a reload
(`COOKIE_SECURE` + TLS), and confirm no CORS error appears in the console
(`CORS_ALLOWED_ORIGINS`). Then confirm rate limiting sees real client addresses by hitting a
rate-limited route from two different source IPs (`TRUST_PROXY`/`TRUST_PROXY_HOPS`).

---

## Worked example — Traefik

Static configuration (`traefik.yml`), one entrypoint that redirects to TLS and one that terminates
it with ACME:

```yaml
entryPoints:
  web:
    address: ':80'
    http:
      redirections:
        entryPoint: { to: websecure, scheme: https, permanent: true }
  websecure:
    address: ':443'

certificatesResolvers:
  le:
    acme:
      email: <your operations contact address>
      storage: /letsencrypt/acme.json
      httpChallenge: { entryPoint: web }

providers:
  docker: { exposedByDefault: false }
```

Compose labels on the two application services. `web` takes everything by default; `api` takes
`/api`, `/health` and `/ready` on the same hostname, so the browser origin and the API origin match
and CORS stays simple:

```yaml
services:
  web:
    labels:
      - traefik.enable=true
      - traefik.http.routers.pv-web.rule=Host(`vault.example.com`)
      - traefik.http.routers.pv-web.entrypoints=websecure
      - traefik.http.routers.pv-web.tls.certresolver=le
      - traefik.http.services.pv-web.loadbalancer.server.port=3000

  api:
    labels:
      - traefik.enable=true
      - traefik.http.routers.pv-api.rule=Host(`vault.example.com`) && (PathPrefix(`/api`) || Path(`/health`) || Path(`/ready`))
      - traefik.http.routers.pv-api.entrypoints=websecure
      - traefik.http.routers.pv-api.tls.certresolver=le
      - traefik.http.routers.pv-api.priority=100
      - traefik.http.services.pv-api.loadbalancer.server.port=3000
      # Defence in depth: never route /metrics or the API docs, whatever the app is configured to do.
      - traefik.http.routers.pv-block.rule=Host(`vault.example.com`) && (Path(`/metrics`) || PathPrefix(`/api/v1/docs`) || Path(`/api/v1/openapi.json`))
      - traefik.http.routers.pv-block.entrypoints=websecure
      - traefik.http.routers.pv-block.tls.certresolver=le
      - traefik.http.routers.pv-block.priority=200
      - traefik.http.routers.pv-block.middlewares=pv-deny
      - traefik.http.middlewares.pv-deny.ipallowlist.sourcerange=127.0.0.1/32
```

With this in front of the stack, set `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=1`, `COOKIE_SECURE=true`,
`CORS_ALLOWED_ORIGINS=https://vault.example.com` and `WEB_BASE_URL=https://vault.example.com`.

Also stop publishing the container ports to the host once the proxy is on the same Docker network:
`API_HOST_PORT` and `WEB_HOST_PORT` publish to `0.0.0.0` by default, which bypasses the proxy
entirely. Bind them to `127.0.0.1`, or remove the `ports:` mappings and let Traefik reach the
services over the Docker network.

If you route `/status` to an external monitor, add it to the `pv-api` rule and rely on its bearer
token for authorization — that endpoint authenticates itself, so it does not need a separate proxy
middleware.

---

## Verify

```bash
curl -sfI https://vault.example.com/health          # 200
curl -s   https://vault.example.com/metrics         # must NOT return metrics
curl -s   https://vault.example.com/api/v1/docs     # must NOT return Swagger UI
curl -s   https://vault.example.com/status          # 404 (no token) or 401 (wrong token) — never 200
curl -s -H "Authorization: Bearer $STATUS_TOKEN" https://vault.example.com/status   # 200
```

Then sign in through the browser and confirm the session cookie is marked `Secure` in devtools.

## Rollback

Every setting here is an env var plus a proxy config change. To back out, revert the labels, restore
the previous `TRUST_PROXY`/`COOKIE_SECURE`/`CORS_ALLOWED_ORIGINS`/`WEB_BASE_URL` values, and restart
the API. Nothing in the database changes.
