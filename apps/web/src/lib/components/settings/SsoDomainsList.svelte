<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { requestConfirm } from '$lib/state/confirm.svelte.js'
  import {
    deleteOrgSsoDomain,
    updateOrgSsoDomain,
    type OrgSsoDomain,
  } from '$lib/api/org-sso-domains.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import SsoDomainRow from './SsoDomainRow.svelte'
  import { errorMessageFor } from './sso-domain-errors.js'

  // Story 69.10: the mapped domains (remove error banner plus the table) as one replaceable region.
  // This component owns the edit/remove state (one row is edited at a time, every row shares
  // `busyKey`); each row edits it through bindable props and callbacks (moved verbatim from the panel).
  let {
    domains,
    data,
  }: {
    domains: readonly OrgSsoDomain[]
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

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
    const confirmed = await requestConfirm({
      title: 'Remove domain mapping?',
      message: `Remove the mapping for ${row.domain}? This cannot be undone.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    })
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

<!-- @region settings.sso-domains.list -->
<RegionFragment>
  {#if removeError}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {removeError}
    </p>
  {/if}

  <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    {#if domains.length === 0}
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
          {#each domains as row (row.id)}
            <SsoDomainRow
              {row}
              editing={editId === row.id}
              bind:editDomain
              bind:editProvider
              {editError}
              busy={busyKey === row.id}
              onEdit={startEdit}
              onCancel={cancelEdit}
              onSave={onSaveEdit}
              {onRemove}
            />
          {/each}
        </tbody>
      </table>
    {/if}<InjectionPoint name="settings.sso-domains.list" {data} />
  </div>
</RegionFragment>
