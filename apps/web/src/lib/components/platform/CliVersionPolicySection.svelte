<script lang="ts">
  // Story 43.7: the effective CLI version policy (GET /api/v1/client-version-policy), exactly as
  // the server publishes it to pvault. Every server value is rendered as text only — never as a
  // link or attribute — and every unavailable state is stated explicitly (AC-1/AC-3/AC-4).
  import type {
    CliVersionPolicyResult,
    CliVersionPolicyUnavailableReason,
  } from '$lib/api/platform.js'
  import {
    deriveCliPolicyWarnings,
    describeCurrent,
    hasAdministratorWithdrawals,
  } from '$lib/platform/cli-version-policy-view.js'

  let { result }: { result: CliVersionPolicyResult } = $props()

  const RUNBOOK_URL =
    'https://github.com/nestormata/project-vault/blob/main/docs/runbooks/cli-version-policy.md'

  const UNAVAILABLE_MESSAGES: Record<
    CliVersionPolicyUnavailableReason,
    { lead: string; detail?: string }
  > = {
    not_supported: {
      lead: 'This API version does not publish a CLI version policy.',
      detail: 'It predates the pvault version check; upgrade the API to see it.',
    },
    rate_limited: {
      lead: 'The CLI version policy is temporarily unavailable (rate limited).',
      detail:
        'Reload in a minute. The API allows 60 policy requests per minute per client address, and requests from this web app all count as one address.',
    },
    api_unavailable: {
      lead: 'The CLI version policy could not be loaded because the API is unavailable.',
    },
    timeout: {
      lead: 'The CLI version policy did not load in time.',
      detail: 'Reload the page to try again.',
    },
    invalid_response: { lead: 'The API returned a CLI version policy this page could not read.' },
    error: { lead: 'The CLI version policy could not be loaded.' },
  }

  // The reason only ever selects a fixed message; an unexpected value falls back to `error`.
  function unavailableMessage(reason: string) {
    return Object.hasOwn(UNAVAILABLE_MESSAGES, reason)
      ? UNAVAILABLE_MESSAGES[reason as CliVersionPolicyUnavailableReason]
      : UNAVAILABLE_MESSAGES.error
  }
</script>

<section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-base font-semibold text-gray-900">CLI Version Policy</h2>
  <p class="mt-1 text-sm text-gray-500">
    What this server tells pvault command-line clients when they check their version.
  </p>

  {#if result.status === 'ok'}
    {@const policy = result.policy}
    {@const current = describeCurrent(policy)}
    {@const warnings = deriveCliPolicyWarnings(policy)}
    {#if warnings.length > 0}
      <div
        role="note"
        data-testid="cli-policy-warning"
        class="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <ul class="list-disc space-y-1 pl-5">
          {#each warnings as warning (warning)}
            <li>{warning}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <dl class="mt-4 space-y-4 text-sm text-gray-700">
      <div data-testid="cli-policy-current">
        <dt class="font-medium text-gray-900">Current CLI release</dt>
        <dd class="mt-1">
          {#if current.kind === 'version'}
            <code class="font-mono text-xs break-all">{current.version}</code>
            <span class="block text-gray-500"
              >pvault older than this prints a notice at most once a day; pvault newer than this is
              told the server is older.</span
            >
          {:else if current.kind === 'development'}
            <span class="text-gray-500"
              >Not advertised — this server is a development build, so pvault shows no out-of-date
              notices.</span
            >
          {:else}
            <span class="text-gray-500"
              >Not advertised — this server's release version (<code
                class="font-mono text-xs break-all">{current.serverVersion}</code
              >) is not a plain X.Y.Z version, so pvault shows no out-of-date notices.</span
            >
          {/if}
        </dd>
      </div>

      <div data-testid="cli-policy-minimum">
        <dt class="font-medium text-gray-900">Minimum supported version</dt>
        <dd class="mt-1">
          {#if policy.cli.minimumSupported !== null}
            <code class="font-mono text-xs break-all">{policy.cli.minimumSupported}</code>
            <span class="block text-gray-500"
              >pvault below this prints a warning but keeps working.</span
            >
          {:else}
            <span class="text-gray-500">No minimum supported version is configured.</span>
          {/if}
        </dd>
      </div>

      <div data-testid="cli-policy-withdrawn">
        <dt class="font-medium text-gray-900">Withdrawn versions</dt>
        <dd class="mt-1">
          {#if policy.cli.withdrawn.length > 0}
            <div class="overflow-x-auto">
              <table class="w-full table-fixed text-left text-sm">
                <caption class="sr-only">Withdrawn pvault versions</caption>
                <thead class="text-xs text-gray-500 uppercase">
                  <tr>
                    <th scope="col" class="w-2/5 py-1 pr-3 font-medium">Version</th>
                    <th scope="col" class="py-1 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                  {#each policy.cli.withdrawn as entry, index (index)}
                    <tr>
                      <td class="py-1 pr-3 align-top">
                        <code class="font-mono text-xs break-all">{entry.version}</code>
                      </td>
                      <td class="py-1 align-top break-words">
                        {#if entry.reason.trim() === ''}
                          <span class="text-gray-400">(no reason given)</span>
                        {:else}
                          <bdi>{entry.reason}</bdi>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <p class="mt-2 text-gray-500">
              These exact versions refuse to run (exit code 29) before requesting any secret.
              PVAULT_NO_VERSION_CHECK does not bypass this.
            </p>
            {#if hasAdministratorWithdrawals(policy)}
              <p class="mt-1 text-gray-500">
                Entries with this reason were added through CLI_WITHDRAWN_VERSIONS on this server;
                the others ship with the release.
              </p>
            {/if}
          {:else}
            <span class="text-gray-500">No pvault versions are withdrawn.</span>
          {/if}
        </dd>
      </div>
    </dl>

    <p class="mt-4 text-xs text-gray-500">
      The API reads this policy at startup: environment-variable changes apply after an API restart.
      pvault caches it for up to 1 hour, so clients may take that long to see a change.
    </p>
  {:else}
    {@const unavailable = unavailableMessage(result.reason)}
    <div role="status" class="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
      <p>
        <strong>{unavailable.lead}</strong>
        {#if unavailable.detail}{unavailable.detail}{/if}
      </p>
    </div>
  {/if}

  {#if result.status === 'ok' || result.reason === 'not_supported'}
    <p class="mt-3 text-sm">
      <a
        href={RUNBOOK_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-indigo-600 underline"
      >
        → CLI version policy runbook (docs/runbooks/cli-version-policy.md)
      </a>
    </p>
  {/if}
</section>
