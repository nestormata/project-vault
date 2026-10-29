<script lang="ts">
  import { requestConfirm } from '$lib/state/confirm.svelte.js'
  import { invalidateAll } from '$app/navigation'
  import { unlinkExternalIdentity, type ExternalIdentity } from '$lib/api/external-identities.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { externalIdentityErrorMessage } from './external-identity-errors.js'

  // Story 69.11: the linked identities (unlink error banner plus the table) as one replaceable
  // region. It owns the unlink state: every row shares `busyKey`, so only one unlink runs at a time.
  let {
    identities,
    data,
  }: {
    identities: readonly ExternalIdentity[]
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  function formatCreatedAt(iso: string): string {
    return new Date(iso).toLocaleString()
  }
  // AC-3: unlink — confirm() dialog, matching /settings/users's onRemoveOrgUser pattern.
  let busyKey = $state<string | null>(null)
  let unlinkError = $state<string | null>(null)
  async function onUnlink(row: ExternalIdentity) {
    if (busyKey) return
    const confirmed = await requestConfirm({
      title: 'Unlink identity?',
      message: `Unlink ${row.email}'s ${row.providerName} identity? They will no longer be able to sign in via this SSO provider.`,
      confirmLabel: 'Unlink',
      variant: 'danger',
    })
    if (!confirmed) return
    busyKey = row.id
    unlinkError = null
    try {
      await unlinkExternalIdentity(fetch, row.id)
      await invalidateAll()
    } catch (error) {
      unlinkError = externalIdentityErrorMessage(error, ['not_found'], 'Failed to unlink identity.')
    } finally {
      busyKey = null
    }
  }
</script>

<!-- @region settings.external-identities.list -->
<RegionFragment>
  {#if unlinkError}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {unlinkError}
    </p>
  {/if}

  <div class="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    {#if identities.length === 0}
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
          {#each identities as row (row.id)}
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
    {/if}<InjectionPoint name="settings.external-identities.list" {data} />
  </div>
</RegionFragment>
