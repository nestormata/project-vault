# CLI version policy and withdrawing a `pvault` version

<!-- Verified against apps/api/src/config/env.ts, apps/api/src/routes/client-version-policy.ts,
     apps/api/src/modules/client-versions/{policy,cli-version-policy}.ts,
     packages/cli/src/version-check.ts (Story 43.6) -->

## When to use

- An upstream advisory says a `pvault` CLI release is known-bad, and your users must stop running
  it now, before you upgrade the server.
- You want users of old CLIs to see a warning (a minimum supported version).
- Users report `error: pvault X.Y.Z has been withdrawn by <host>` or exit code `29`.

## Background

Every server serves a public, unauthenticated, static policy at
`GET /api/v1/client-version-policy`. It contains no tenant data and makes no database query. It is
rate-limited to 60 requests per minute per IP, with `Cache-Control: public, max-age=300`. The
`pvault` CLI reads it before `get`, `run`, `write-env` and `login` and caches it for 1 hour per
server.

- **`current`** is this server's own `RELEASE_VERSION` when it is a strict `X.Y.Z`, otherwise
  `null`. A CLI older than `current` prints a notice at most once a day. A CLI newer than
  `current` also prints a notice, because the server is older than the CLI.
- **`minimumSupported`**: a CLI below it prints a warning. It is never refused.
- **`withdrawn`**: those exact versions refuse to run and exit `29`, before any credential is
  requested. `PVAULT_NO_VERSION_CHECK` never bypasses this.

The policy is the release's built-in list (`BAKED_CLI_VERSION_POLICY`) merged with two optional
environment variables. The merge can only **tighten** the built-in policy:

| Variable                        | Format                                                     | Effect                                                                                                         |
| ------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `CLI_MINIMUM_SUPPORTED_VERSION` | strict `X.Y.Z` (no `v`, no prerelease)                     | The higher of this and the built-in minimum applies. A lower value is ignored, with a boot `warn` naming both. |
| `CLI_WITHDRAWN_VERSIONS`        | comma-separated strict semver, at most 50 (`1.2.1, 1.2.2`) | Added to the built-in list with the fixed reason `Withdrawn by this server's administrator.`                   |

Both variables carry versions only, never free text. An invalid value fails boot and names the bad
entry. Values must also stay within what `pvault` can parse: each version at most 128 characters,
every numeric part at most 9007199254740991, and at most 100 withdrawn versions in total (built-in
list included). `pvault` discards a policy that breaks any of these as a whole, which would
silently stop withdrawals from being enforced, so the API refuses to boot instead of serving it. At boot the API logs one `info` line, `effective CLI version policy`, with the minimum and
each withdrawn version and its source (`baked`/`env`). It logs a `warn` if the minimum is above this
server's own release or if this server's own release is withdrawn.

**This is a user-protection notice, not a security control.** A modified or pre-43.6 binary ignores
it. Withdrawing a version does not revoke anything it may have exposed.

## Fix: withdraw a CLI version

1. Add the exact version(s) to `CLI_WITHDRAWN_VERSIONS` in the API's environment, for example
   `CLI_WITHDRAWN_VERSIONS=1.2.1`.
2. Restart the API. Check the boot log line `effective CLI version policy` lists the version
   with `source: env`.
3. Revoke or rotate whatever the defect may have exposed: machine-user API keys used with that CLI,
   and CLI sessions (see [secret rotation](secret-rotation.md) and
   [incident response](incident-response.md) § Emergency revoke). Withdrawal alone does not do
   this.
4. Tell users to download a supported release from
   `https://github.com/nestormata/project-vault/releases`.

## Verify

```bash
curl -s https://vault.example.com/api/v1/client-version-policy | jq '.data.clients.cli'
```

Clients see the change within **1 hour**, which is the CLI's cache TTL. A client whose cache still
holds an earlier answer keeps using it until the TTL expires.

## Troubleshooting

- **Users behind one NAT or proxy get no notices.** More than 60 cold-cache checks per minute from
  one IP return `429`. The CLI treats that as unreachable and proceeds silently. Check `trustProxy`
  (`TRUST_PROXY`) if every client appears as the proxy's IP. Do not raise the limit pre-emptively.
- **A sealed vault** answers `503` here too. The CLI proceeds, and it cannot fetch secrets anyway.
- **A user is refused while the server is unreachable.** The CLI keeps the last confirmed
  withdrawal for that server and CLI version (the "sticky" verdict). The message names the local
  cache file (`~/.config/pvault/version-check.json`). Deleting that file clears the verdict if the
  user trusts it is wrong. Upgrading the CLI also clears it.

## Rollback

Remove the version from `CLI_WITHDRAWN_VERSIONS` and restart. A version withdrawn by the built-in
list cannot be un-withdrawn by configuration. Clients that last saw it withdrawn clear the verdict on
their next successful check.
