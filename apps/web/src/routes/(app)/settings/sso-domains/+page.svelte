<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { ORG_SSO_DOMAIN_ERROR_CODES } from '@project-vault/shared'
  import {
    createOrgSsoDomain,
    deleteOrgSsoDomain,
    updateOrgSsoDomain,
    type OrgSsoDomain,
  } from '$lib/api/org-sso-domains.js'

  let { data } = $props()

  // AC-2/AC-3 error contract — mirrors /settings/users's onRemoveOrgUser pattern: branch on the
  // typed ApiClientError.code rather than blindly relaying error.message for any error. Only the
  // five contract codes from ORG_SSO_DOMAIN_ERROR_CODES are trusted to surface their server
  // message verbatim; any other/unexpected code (e.g. an unrelated 500) falls back to the
  // caller-supplied generic copy instead of leaking an unvetted server string to the admin.
  const KNOWN_SSO_DOMAIN_ERROR_CODES: readonly string[] = Object.values(ORG_SSO_DOMAIN_ERROR_CODES)

  function errorMessageFor(error: unknown, fallback: string): string {
    if (!(error instanceof ApiClientError)) return fallback
    if (!error.code || !KNOWN_SSO_DOMAIN_ERROR_CODES.includes(error.code)) return fallback
    return error.message ?? fallback
  }

  function formatCreatedAt(iso: string): string {
    return new Date(iso).toLocaleString()
  }

  // AC-2: create form. Task 6 judgment call — providerName is a free-text input, not a <select>:
  // there is currently no authenticated "list registered strategies" endpoint exposed to the web
  // app (/settings/extensions's status endpoint only returns the single currently-loaded
  // extension's manifest, not a full strategies list), and building one is explicitly out of
  // scope for this story (Dev Notes judgment call #2) — a text input with inline server-validated
  // error display is the documented, honest fallback.
  let newDomain = $state('')
  let newProvider = $state('')
  let createBusy = $state(false)
  let createError = $state<string | null>(null)

  async function onCreate(event: SubmitEvent) {
    event.preventDefault()
    if (createBusy) return
    createBusy = true
    createError = null
    try {
      await createOrgSsoDomain(fetch, { domain: newDomain, providerName: newProvider })
      newDomain = ''
      newProvider = ''
      await invalidateAll()
    } catch (error) {
      createError = errorMessageFor(error, 'Failed to add domain.')
    } finally {
      createBusy = false
    }
  }

  // AC-3: inline edit per row.
  let editId = $state<string | null>(null)
  let editDomain = $state('')
  let editProvider = $state('')
  let editError = $state<string | null>(null)
  let busyKey = $state<string | null>(null)

  function startEdit(row: OrgSsoDomain) {
    editId = row.id
    editDomain = row.domain
    editProvider = row.providerName
    editError = null
  }

  function cancelEdit() {
    editId = null
    editError = null
  }

  async function onSaveEdit(row: OrgSsoDomain) {
    if (busyKey) return
    busyKey = row.id
    editError = null
    try {
      await updateOrgSsoDomain(fetch, row.id, { domain: editDomain, providerName: editProvider })
      editId = null
      await invalidateAll()
    } catch (error) {
      editError = errorMessageFor(error, 'Failed to update domain.')
    } finally {
      busyKey = null
    }
  }

  // AC-4: remove — confirm() dialog, matching /settings/users's onRemoveOrgUser pattern.
  let removeError = $state<string | null>(null)

  async function onRemove(row: OrgSsoDomain) {
    if (busyKey) return
    const confirmed = confirm(`Remove the mapping for ${row.domain}? This cannot be undone.`)
    if (!confirmed) return
    busyKey = row.id
    removeError = null
    try {
      await deleteOrgSsoDomain(fetch, row.id)
      await invalidateAll()
    } catch (error) {
      removeError = errorMessageFor(error, 'Failed to remove domain.')
    } finally {
      busyKey = null
    }
  }
</script>

<svelte:head>
  <title>SSO Domains | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">SSO Domains</h1>
  <p class="mt-2 text-gray-500">
    Route email domains to an SSO provider so people at that domain sign in through it instead of a
    password.
  </p>

  {#if !data.allowed}
    <!-- AC-5: minimumRole 'admin' includes 'owner' — see Dev Notes judgment call. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">You need the Admin role to manage SSO domains.</p>
      <a href={resolve('/settings')} class="mt-2 inline-block text-sm text-indigo-600 underline">
        ← Back to Settings
      </a>
    </div>
  {:else if data.mfaRequired}
    <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <p class="text-amber-900">Enable multi-factor authentication to manage SSO domains.</p>
      <a
        href={resolve('/settings/security')}
        class="mt-2 inline-block text-sm font-medium text-indigo-600 underline"
      >
        Go to Security →
      </a>
    </div>
  {:else if data.errorMessage}
    <p
      class="mt-8 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {data.errorMessage}
    </p>
  {:else}
    <form
      class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      onsubmit={onCreate}
    >
      <h2 class="text-lg font-semibold text-slate-950">Add domain</h2>
      <div class="mt-4 flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-sm" for="new-domain">
          Domain
          <input
            id="new-domain"
            type="text"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            placeholder="acme.com"
            bind:value={newDomain}
            required
          />
        </label>
        <label class="flex flex-col gap-1 text-sm" for="new-provider">
          Provider name
          <input
            id="new-provider"
            type="text"
            class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
            placeholder="e.g. test.mock-sso-extension"
            bind:value={newProvider}
            required
          />
        </label>
        <button
          type="submit"
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={createBusy || !newDomain || !newProvider}
        >
          {createBusy ? 'Adding…' : 'Add domain'}
        </button>
      </div>
      <p class="mt-2 text-xs text-slate-500">
        Must be a bare domain (no @, no wildcard, no whitespace) — not on our list of shared public
        email providers.
      </p>
      {#if createError}
        <p class="mt-2 text-sm text-red-700" role="alert">{createError}</p>
      {/if}
    </form>

    {#if removeError}
      <p
        class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        role="alert"
      >
        {removeError}
      </p>
    {/if}

    <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {#if data.domains.length === 0}
        <p class="p-6 text-center text-slate-600">No SSO domains configured yet.</p>
      {:else}
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th class="px-4 py-3 font-semibold">Domain</th>
              <th class="px-4 py-3 font-semibold">Provider</th>
              <th class="px-4 py-3 font-semibold">Created</th>
              <th class="px-4 py-3 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {#each data.domains as row (row.id)}
              <tr
                class="border-b border-slate-100 align-top last:border-b-0"
                data-testid={editId === row.id ? `edit-row-${row.id}` : undefined}
              >
                {#if editId === row.id}
                  <td class="px-4 py-3">
                    <input
                      class="w-full rounded-lg border border-slate-300 px-2 py-1"
                      aria-label="Domain"
                      bind:value={editDomain}
                    />
                  </td>
                  <td class="px-4 py-3">
                    <input
                      class="w-full rounded-lg border border-slate-300 px-2 py-1"
                      aria-label="Provider name"
                      bind:value={editProvider}
                    />
                  </td>
                  <td class="px-4 py-3 text-slate-600">{formatCreatedAt(row.createdAt)}</td>
                  <td class="px-4 py-3 text-right">
                    <div class="flex flex-col items-end gap-1">
                      <div class="flex gap-2">
                        <button
                          type="button"
                          class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={busyKey === row.id}
                          onclick={() => onSaveEdit(row)}
                        >
                          {busyKey === row.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          class="text-sm text-slate-500 underline"
                          onclick={cancelEdit}
                        >
                          Cancel
                        </button>
                      </div>
                      {#if editError}
                        <p class="max-w-xs text-left text-xs text-red-700" role="alert">
                          {editError}
                        </p>
                      {/if}
                    </div>
                  </td>
                {:else}
                  <td class="px-4 py-3 font-medium text-slate-900">{row.domain}</td>
                  <td class="px-4 py-3 text-slate-600">{row.providerName}</td>
                  <td class="px-4 py-3 text-slate-600">{formatCreatedAt(row.createdAt)}</td>
                  <td class="px-4 py-3 text-right">
                    <div class="flex justify-end gap-2">
                      <button
                        type="button"
                        class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={busyKey === row.id}
                        onclick={() => startEdit(row)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={busyKey === row.id}
                        onclick={() => onRemove(row)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
</div>
