# `@project-vault/agent`

Machine-user authentication and programmatic secret retrieval for
[Project Vault](https://github.com/nestormata/project-vault).

> **Bundled, not published.** This package is `"private": true` and is not on npm. No workflow
> publishes it, and there is no supported way to `npm install` it. It exists as an internal
> library that [`@project-vault/vault-action`](../vault-action/README.md) bundles verbatim into
> its `dist/index.js`. Consume it through that action, or call the machine HTTP API directly as
> documented in [`docs/machine-users.md`](../../docs/machine-users.md).
>
> If you are looking for a documented, versioned integration surface, that is the HTTP API and
> the GitHub Action — not this package.

It wraps the two-step machine-user flow (exchange a `pk_` API key for a short-lived JWT, then
fetch a credential value with that JWT) behind a single `getSecret(name)` call, and adds an
encrypted offline cache so a CI job can survive a briefly unreachable vault.

## Usage

```ts
import { createVaultAgent } from '@project-vault/agent'

const agent = createVaultAgent({
  apiKey: process.env.VAULT_API_KEY!,
  baseUrl: 'https://vault.example.com',
  projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
})

const databaseUrl = await agent.getSecret('DATABASE_URL')
```

`createVaultAgent()` performs no I/O. The token exchange happens lazily on the first
`getSecret()` call, and the resulting access token is reused for the agent's lifetime; a `401`
triggers exactly one transparent re-exchange and retry.

## Options

| Option | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `apiKey` | `string` | yes | — | The machine user's `pk_...` key. Also the input to the cache-encryption key derivation. |
| `baseUrl` | `string` | yes | — | Project Vault base URL, with no trailing `/api/v1`. |
| `projectId` | `string` | yes | — | The project UUID the API key is scoped to. Must match, or the server answers `403`. |
| `cachePath` | `string` | no | `$VAULT_CACHE_PATH`, else `~/.project-vault/cache.json` | Where the offline cache file lives. |
| `fallbackThreshold` | `number` | no | `$VAULT_FALLBACK_THRESHOLD`, else `3` | Consecutive network failures, within a rolling 30-second window, before the agent switches to cache-first mode. |

### Environment variables

| Variable | Effect |
|---|---|
| `VAULT_CACHE_PATH` | Overrides the cache file location. Consulted only when `cachePath` is not passed explicitly. |
| `VAULT_FALLBACK_THRESHOLD` | Overrides the fallback threshold. Consulted only when `fallbackThreshold` is not passed explicitly. |

An explicit option always wins over the environment variable.

## Offline cache

Every successful retrieval of a **cacheable** credential is written to the cache file, so a later
call can still be served while the vault is unreachable.

- **Location:** `~/.project-vault/cache.json` by default (`cachePath` / `VAULT_CACHE_PATH`
  override it). The file is written atomically and `chmod`ed to `0600`.
- **Encryption:** each value is sealed with **AES-256-GCM**, under a key derived from the API key
  via **HKDF**. The API key itself is never written to disk. A cache written under a previous API
  key cannot be read after rotation — the auth-tag check fails and the agent raises
  `VaultCacheDecryptionError` rather than silently treating it as a cache miss or, worse, reading
  raw bytes as plaintext. Delete the cache file when you rotate a key.
- **TTL:** entries record their own `cachedAt` and `ttlSeconds`, defaulting to **86,400 seconds
  (24 hours)**. An entry past its TTL is refused with `VaultCacheExpiredError`, never served
  stale.
- **`cacheable: false` is honored.** The server marks high-sensitivity credentials non-cacheable;
  those are never written, and an already-cached copy of a credential that later becomes
  non-cacheable is actively deleted on the next successful live fetch.

### Fallback mode

A **network-level** failure — connection refused, DNS failure, timeout — counts toward
`fallbackThreshold`. A resolved HTTP response, including a `5xx`, is a server answer and never
counts. `fallbackThreshold` consecutive failures inside a rolling 30-second window flip the agent
into fallback mode; any success resets the counter to zero.

While in fallback mode `getSecret()` serves from cache and skips the live call, except that it
re-attempts one live call at most every 30 seconds to detect recovery. Recovery detection is
reactive (checked on the next `getSecret()`), not a background timer — this library targets
short-lived CI processes and must never keep one alive.

`vault-action` constructs the agent with `fallbackThreshold: 1`, so on a GitHub runner the very
first network failure goes straight to cache.

On entering fallback mode the agent records a one-shot activation beacon and, on the next
successful live call, posts it to `POST /api/v1/machine/cache-activated` so operators can see that
a consumer degraded. The beacon is strictly best-effort: any failure to send it is swallowed and
never surfaces to `getSecret()`'s caller.

## Errors

Every error thrown by this package extends `VaultAgentError` and carries a stable `.code`.
Discriminate on `.code` rather than `instanceof` where the package may be duplicated in a bundle.

| Class | `.code` | Raised when |
|---|---|---|
| `VaultAgentError` | `token_exchange_failed` | Step 1 answered non-`2xx` — bad, revoked, or expired API key. |
| `VaultAgentError` | `credential_not_found` | Step 2 answered `404`. |
| `VaultAgentError` | `insufficient_role` | Step 2 answered `403` — the token is scoped to a different project. |
| `VaultAgentError` | `ambiguous_credential_name` | Step 2 answered `409` — two credentials share that name in the project. |
| `VaultAgentError` | `vault_request_failed` | Step 2 answered some other non-`2xx`. |
| `VaultUnreachableError` | `vault_unreachable` | Vault unreachable and this name was never cached. |
| `VaultUnreachableNonCacheableError` | `vault_unreachable_non_cacheable` | Vault unreachable and this name is flagged `cacheable: false`, so it can never be served offline. |
| `VaultCacheExpiredError` | `cache_expired` | Vault unreachable and the cached entry has outlived its TTL. |
| `VaultCacheDecryptionError` | `cache_decryption_failed` | A cached entry failed AES-GCM verification — almost always a cache written under a previous API key. |
| `VaultCacheCorruptedError` | `cache_corrupted` | The cache file's JSON could not be parsed. |
| `VaultMultiFieldSecretUnsupportedError` | `multi_field_secret_unsupported` | See below. |

## Limitation: multi-field secrets are not supported

`getSecret(name)` returns a single `Promise<string>` and has no field selector, so it always
requests the machine reveal route with no `?field=`. A genuinely multi-field credential answers
that request with a `fields` array instead of a `value` string, and the agent throws
`VaultMultiFieldSecretUnsupportedError` rather than caching or returning `undefined` as if it
were the secret.

There is no workaround inside this package. Either split the credential into single-value
credentials, or call the HTTP route directly with `?field=<key>` — see
[`docs/machine-users.md`](../../docs/machine-users.md).

## Maintainers

The cache-encryption envelope is duplicated across three independently-versioned artifacts. Any
security-relevant change to it must follow the checklist in
[`MAINTAINERS.md`](./MAINTAINERS.md).

## License

Part of the [Project Vault](https://github.com/nestormata/project-vault) monorepo, covered by the
repository's root [`LICENSE`](../../LICENSE) (GNU AGPLv3).
