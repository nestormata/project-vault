<script lang="ts">
  import { resolve } from '$app/paths'
  import { canCreateCredential } from '$lib/components/onboarding/onboarding-logic.js'
  import { canImportCredentials } from '$lib/credentials/permissions.js'
  import type { CredentialStatus } from '@project-vault/shared'

  let { data } = $props()

  const canCreate = $derived(canCreateCredential(data.orgRole))
  const canImport = $derived(canImportCredentials(data.orgRole))

  function statusClass(status: CredentialStatus): string {
    switch (status) {
      case 'active':
        return 'bg-emerald-100 text-emerald-800'
      case 'expiring':
        return 'bg-amber-100 text-amber-900'
      case 'expired':
        return 'bg-red-100 text-red-800'
    }
  }

  function formatDate(value: string | null): string {
    if (!value) return '—'
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function filterHref(overrides: { q?: string; status?: string; page?: number }): string {
    const params = new URLSearchParams()
    const q = overrides.q ?? data.filters.q
    const status = overrides.status ?? data.filters.status
    const page = overrides.page ?? data.filters.page
    if (q) params.set('q', q)
    if (status) params.set('status', status)
    if (page > 1) params.set('page', String(page))
    const query = params.toString()
    return resolve(`/projects/${data.projectId}/credentials${query ? `?${query}` : ''}`)
  }
</script>

<svelte:head>
  <title>Credentials | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  <div
    class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
  >
    <div>
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Credentials</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">Project credentials</h1>
      <p class="mt-2 text-slate-600">Browse and manage secrets for this project.</p>
    </div>
    <div class="flex flex-col gap-2 sm:flex-row">
      {#if canCreate}
        <a
          class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
          href={resolve(`/projects/${data.projectId}/credentials/new`)}
        >
          Add credential
        </a>
      {/if}
      {#if canImport}
        <a
          class="rounded-xl border border-slate-300 px-4 py-3 text-center font-semibold text-slate-900"
          href={resolve(`/projects/${data.projectId}/credentials/import`)}
        >
          Import
        </a>
      {/if}
    </div>
  </div>

  {#if data.notFound}
    <div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
      <p class="text-red-800">This project was not found or you do not have access.</p>
    </div>
  {:else}
    <form
      class="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end"
      method="GET"
      action={resolve(`/projects/${data.projectId}/credentials`)}
    >
      <div class="flex-1 space-y-1">
        <label class="block text-sm font-medium text-slate-800" for="credential-search"
          >Search</label
        >
        <input
          id="credential-search"
          class="w-full rounded-xl border border-slate-300 px-3 py-2"
          type="search"
          name="q"
          value={data.filters.q}
          placeholder="Search by name"
        />
      </div>
      <div class="space-y-1">
        <label class="block text-sm font-medium text-slate-800" for="credential-status"
          >Status</label
        >
        <select
          id="credential-status"
          class="rounded-xl border border-slate-300 px-3 py-2"
          name="status"
          value={data.filters.status}
        >
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="expiring">Expiring</option>
          <option value="expired">Expired</option>
        </select>
      </div>
      <button class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white" type="submit">
        Apply filters
      </button>
      {#if data.filters.q || data.filters.status}
        <a
          class="py-2 text-sm font-medium text-slate-700 underline"
          href={resolve(`/projects/${data.projectId}/credentials`)}
        >
          Clear
        </a>
      {/if}
    </form>

    {#if data.credentials.items.length === 0}
      <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
        <h2 class="text-xl font-semibold text-slate-950">No credentials found</h2>
        <p class="mt-2 text-slate-600">
          {#if data.filters.q || data.filters.status}
            Try adjusting your filters.
          {:else if canCreate}
            Add your first credential to get started.
          {:else}
            No credentials have been added to this project yet.
          {/if}
        </p>
      </div>
    {:else}
      <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th class="px-4 py-3 font-semibold">Name</th>
              <th class="px-4 py-3 font-semibold">Status</th>
              <th class="px-4 py-3 font-semibold">Tags</th>
              <th class="px-4 py-3 font-semibold">Expires</th>
              <th class="px-4 py-3 font-semibold">Deps</th>
            </tr>
          </thead>
          <tbody>
            {#each data.credentials.items as credential (credential.id)}
              <tr class="border-b border-slate-100 last:border-b-0">
                <td class="px-4 py-3">
                  <a
                    class="font-semibold text-slate-950 underline"
                    href={resolve(`/projects/${data.projectId}/credentials/${credential.id}`)}
                  >
                    {credential.name}
                  </a>
                </td>
                <td class="px-4 py-3">
                  <span
                    class={`rounded-full px-2 py-1 text-xs font-semibold ${statusClass(credential.status)}`}
                  >
                    {credential.status}
                  </span>
                </td>
                <td class="px-4 py-3 text-slate-600">
                  {credential.tags.length > 0 ? credential.tags.join(', ') : '—'}
                </td>
                <td class="px-4 py-3 text-slate-600">{formatDate(credential.expiresAt)}</td>
                <td class="px-4 py-3 text-slate-600">
                  {credential.hasDependencies ? 'Yes' : '—'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <p class="text-sm text-slate-600">
        Showing {data.credentials.items.length} of {data.credentials.total} credentials
      </p>
    {/if}
  {/if}
</section>
