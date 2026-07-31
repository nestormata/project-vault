<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError } from '$lib/api/client.js'
  import SettingsFormGate from '$lib/components/settings/SettingsFormGate.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import {
    linkExternalIdentity,
    unlinkExternalIdentity,
    type ExternalIdentity,
  } from '$lib/api/external-identities.js'

  let { data } = $props()

  // AC-2/AC-3 error contract — mirrors /settings/sso-domains's typed ApiClientError.code
  // branching rather than blindly relaying error.message for any error (the exact High finding
  // 14-6's code review caught and fixed — do not reintroduce it here). Only the codes this
  // story's routes actually document are trusted to surface their server message verbatim.
  const KNOWN_LINK_ERROR_CODES = ['conflict', 'user_not_found']
  const KNOWN_UNLINK_ERROR_CODES = ['not_found']

  function errorMessageFor(error: unknown, knownCodes: string[], fallback: string): string {
    if (!(error instanceof ApiClientError)) return fallback
    if (!error.code || !knownCodes.includes(error.code)) return fallback
    return error.message ?? fallback
  }

  function formatCreatedAt(iso: string): string {
    return new Date(iso).toLocaleString()
  }

  // AC-12 Judgment call: providerName is free-text, not a <select> — no authenticated
  // "list registered strategies" endpoint is exposed to the web app today. Same reasoning as
  // 14-6's Task 6 judgment call.
  let newUserId = $state('')
  let newProviderName = $state('')
  let newExternalSubject = $state('')
  let linkBusy = $state(false)
  let linkError = $state<string | null>(null)

  async function onLink(event: SubmitEvent) {
    event.preventDefault()
    if (linkBusy) return
    linkBusy = true
    linkError = null
    try {
      await linkExternalIdentity(fetch, {
        userId: newUserId,
        providerName: newProviderName,
        externalSubject: newExternalSubject,
      })
      newUserId = ''
      newProviderName = ''
      newExternalSubject = ''
      await invalidateAll()
    } catch (error) {
      linkError = errorMessageFor(error, KNOWN_LINK_ERROR_CODES, 'Failed to link identity.')
    } finally {
      linkBusy = false
    }
  }

  // AC-3: unlink — confirm() dialog, matching /settings/users's onRemoveOrgUser pattern.
  let busyKey = $state<string | null>(null)
  let unlinkError = $state<string | null>(null)

  async function onUnlink(row: ExternalIdentity) {
    if (busyKey) return
    const confirmed = confirm(
      `Unlink ${row.email}'s ${row.providerName} identity? They will no longer be able to sign in via this SSO provider.`
    )
    if (!confirmed) return
    busyKey = row.id
    unlinkError = null
    try {
      await unlinkExternalIdentity(fetch, row.id)
      await invalidateAll()
    } catch (error) {
      unlinkError = errorMessageFor(error, KNOWN_UNLINK_ERROR_CODES, 'Failed to unlink identity.')
    } finally {
      busyKey = null
    }
  }
</script>

<svelte:head>
  <title>External Identities | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">External Identities</h1>
  <p class="mt-2 text-gray-500">
    See which org members have a linked external identity for SSO sign-in, link a new one, or unlink
    a stale one.
  </p>

  <SettingsFormGate
    allowed={data.allowed}
    mfaRequired={data.mfaRequired}
    errorMessage={data.errorMessage}
    deniedMessage="You need the Admin role to manage external identities."
    mfaMessage="Enable multi-factor authentication to manage external identities."
  >
    <form class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" onsubmit={onLink}>
      <h2 class="text-lg font-semibold text-slate-950">Link identity</h2>
      <div class="mt-4 flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-sm" for="new-user">
          Member
          <select
            id="new-user"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            bind:value={newUserId}
            required
            aria-describedby="external-identity-member-help"
          >
            <option value="" disabled>Choose a member…</option>
            {#each data.orgUsers as orgUser (orgUser.userId)}
              <option value={orgUser.userId}>{orgUser.email}</option>
            {/each}
          </select>
          <FormHelpText id="external-identity-member-help" kind="select" />
        </label>
        <label class="flex flex-col gap-1 text-sm" for="new-provider-name">
          Provider name
          <input
            id="new-provider-name"
            type="text"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            placeholder="e.g. test.mock-sso-extension"
            aria-describedby="external-identity-provider-help"
            bind:value={newProviderName}
            required
          />
          <FormHelpText id="external-identity-provider-help" kind="text" />
        </label>
        <label class="flex flex-col gap-1 text-sm" for="new-external-subject">
          External subject
          <input
            id="new-external-subject"
            type="text"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            placeholder="e.g. alex-sso-subject-123"
            aria-describedby="external-identity-subject-help"
            bind:value={newExternalSubject}
            required
          />
          <FormHelpText id="external-identity-subject-help" kind="text" />
        </label>
        <button
          type="submit"
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={linkBusy || !newUserId || !newProviderName || !newExternalSubject}
        >
          {linkBusy ? 'Linking…' : 'Link identity'}
        </button>
      </div>
      {#if linkError}
        <p class="mt-2 text-sm text-red-700" role="alert">{linkError}</p>
      {/if}
    </form>

    {#if unlinkError}
      <p
        class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        role="alert"
      >
        {unlinkError}
      </p>
    {/if}

    <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {#if data.identities.length === 0}
        <p class="p-6 text-center text-slate-600">No external identities linked yet.</p>
      {:else}
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th class="px-4 py-3 font-semibold">User</th>
              <th class="px-4 py-3 font-semibold">Provider</th>
              <th class="px-4 py-3 font-semibold">External subject</th>
              <th class="px-4 py-3 font-semibold">Linked</th>
              <th class="px-4 py-3 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {#each data.identities as row (row.id)}
              <tr class="border-b border-slate-100 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">{row.email}</td>
                <td class="px-4 py-3 text-slate-600">{row.providerName}</td>
                <td class="px-4 py-3 text-slate-600">{row.externalSubject}</td>
                <td class="px-4 py-3 text-slate-600">{formatCreatedAt(row.createdAt)}</td>
                <td class="px-4 py-3 text-right">
                  <button
                    type="button"
                    class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={busyKey === row.id}
                    onclick={() => onUnlink(row)}
                  >
                    {busyKey === row.id ? 'Unlinking…' : 'Unlink'}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </SettingsFormGate>
</div>
