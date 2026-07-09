<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { createOrg, listOrgs, type OrgListItem } from '$lib/api/platform.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  let orgs = $state<OrgListItem[]>(data.allowed ? data.orgs : [])
  let pageError = $state<string | null>(data.allowed ? data.errorMessage : null)

  let newOrgName = $state('')
  let newOrgOwnerEmail = $state('')
  let createError = $state<string | null>(null)
  let createMfaError = $state<string | null>(null)
  let createNameError = $state<string | null>(null)
  let createSuccess = $state<string | null>(null)
  let creating = $state(false)

  async function handleCreateOrg(e: SubmitEvent) {
    e.preventDefault()
    creating = true
    createError = null
    createMfaError = null
    createNameError = null
    createSuccess = null

    try {
      const result = await createOrg(fetch, {
        name: newOrgName.trim(),
        ownerEmail: newOrgOwnerEmail.trim(),
      })
      if (result.ownerAccountAction === 'existing_user_added') {
        createSuccess = `Organization "${result.name}" created. ${newOrgOwnerEmail.trim()} was added as owner (existing account).`
      } else {
        createSuccess = `Organization "${result.name}" created. An invitation was sent to ${newOrgOwnerEmail.trim()}.`
      }
      newOrgName = ''
      newOrgOwnerEmail = ''
      const refreshed = await listOrgs(fetch)
      orgs = refreshed.items
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          createMfaError = err.message ?? 'MFA required'
        } else if (err.status === 409 && err.code === 'org_name_taken') {
          createNameError = err.message ?? 'An organization with that name already exists.'
        } else if (err.status === 409 && err.code === 'max_orgs_reached') {
          createError =
            err.message ??
            `This instance has reached its maximum organizations. Increase the limit in Settings.`
        } else if (err.status === 422) {
          createError = err.message ?? 'Validation failed'
        } else if (err.status === 503) {
          const body = err.body as { status?: string; message?: string } | null
          if (body && 'status' in body && !('code' in body)) {
            createError =
              'The vault was sealed while you were on this page — unseal it to continue.'
          } else {
            createError = err.message ?? 'Service unavailable'
          }
        } else {
          createError = err.message ?? 'Failed to create organization'
        }
      } else {
        createError = 'Failed to create organization'
      }
    } finally {
      creating = false
    }
  }
</script>

<svelte:head>
  <title>Organizations | Platform Admin | Project Vault</title>
</svelte:head>

{#if !data.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-4xl px-4 py-8">
    <nav class="mb-4 text-sm text-gray-500">
      <a href={resolve('/platform')} class="hover:underline">Platform Admin</a>
      <span class="mx-2">›</span>
      <a href={resolve('/platform/settings')} class="hover:underline">System Settings</a>
      <span class="mx-2">›</span>
      <span>Organizations</span>
    </nav>

    <h1 class="text-2xl font-bold text-gray-900">Organizations</h1>
    <p class="mt-1 text-gray-500">Manage all organizations on this instance.</p>

    {#if pageError}
      <p
        class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        role="alert"
      >
        {pageError}
      </p>
    {/if}

    <div class="mt-6">
      {#if orgs.length === 0 && !pageError}
        <p class="rounded-lg border border-gray-200 bg-white px-6 py-8 text-center text-gray-500">
          No organizations found.
        </p>
      {:else}
        <DataTable columns={['Name', 'Slug', 'Created', 'Members']}>
          {#each orgs as org (org.id)}
            <tr class="border-b border-slate-100 last:border-b-0">
              <td class="px-4 py-3 font-medium text-slate-900">{org.name}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-600">{org.slug}</td>
              <td class="px-4 py-3 text-sm text-slate-600"
                >{new Date(org.createdAt).toLocaleDateString()}</td
              >
              <td class="px-4 py-3 text-sm text-slate-600">{org.memberCount}</td>
            </tr>
          {/each}
        </DataTable>
      {/if}
    </div>

    <!-- Create org form -->
    <div class="mt-8 rounded-xl border border-gray-200 bg-white p-6">
      <h2 class="text-lg font-semibold text-gray-900">Create organization</h2>

      {#if createSuccess}
        <p
          class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          role="status"
        >
          {createSuccess}
        </p>
      {/if}
      {#if createError}
        <p
          class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          {createError}
          {#if createError.includes('maximum')}
            <a href={resolve('/platform/settings')} class="ml-1 underline">→ Settings</a>
          {/if}
        </p>
      {/if}
      {#if createMfaError}
        <MfaAwareErrorAlert
          message={createMfaError}
          class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        />
      {/if}

      <form class="mt-4 flex flex-col gap-4" onsubmit={(e) => void handleCreateOrg(e)}>
        <label class="flex flex-col text-sm text-gray-700">
          Organization name
          <input
            type="text"
            required
            bind:value={newOrgName}
            class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="Acme Corp"
          />
          {#if createNameError}
            <span class="mt-1 text-xs text-red-600">{createNameError}</span>
          {/if}
        </label>
        <label class="flex flex-col text-sm text-gray-700">
          Owner email
          <input
            type="email"
            required
            bind:value={newOrgOwnerEmail}
            class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="owner@example.com"
          />
        </label>
        <div>
          <button
            type="submit"
            disabled={creating}
            class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create organization'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
