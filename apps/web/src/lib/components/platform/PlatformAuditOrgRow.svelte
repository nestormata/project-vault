<script lang="ts">
  import type { AuditStorageOrgRow } from '$lib/api/platform.js'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import type { AuditQuotaEditor } from './audit-quota-editor.svelte.js'
  import PlatformAuditQuotaForm from './PlatformAuditQuotaForm.svelte'
  import { STATE_BADGE } from './resource-usage-format.js'

  let { row, editor }: { row: AuditStorageOrgRow; editor: AuditQuotaEditor } = $props()

  const badge = $derived(STATE_BADGE[row.state])
</script>

<tr class="border-b border-slate-100 last:border-b-0">
  <td class="px-4 py-3 text-sm">
    <div class="font-medium text-slate-900">{row.orgName}</div>
    <div class="font-mono text-xs text-slate-500">{row.orgId}</div>
  </td>
  <td class="px-4 py-3 text-sm text-slate-700">{formatBytes(row.bytesUsed)} (logical)</td>
  <td class="px-4 py-3 text-sm text-slate-700">
    {row.quotaBytes === null ? 'No quota configured' : `${formatBytes(row.quotaBytes)} (logical)`}
  </td>
  <td class="px-4 py-3 text-sm text-slate-700">
    {#if row.state === 'stale'}
      Stale — {row.lastReconciledAt
        ? `last reconciled ${new Date(row.lastReconciledAt).toLocaleDateString()}`
        : 'never reconciled'}
    {:else if row.utilizationPct === null}
      —
    {:else}
      {row.utilizationPct}%
    {/if}
  </td>
  <td class="px-4 py-3 text-sm text-slate-700">
    {row.writeRatePerMinute === null ? 'Unlimited' : `${row.writeRatePerMinute}/min`}
  </td>
  <td class="px-4 py-3 text-sm">
    <span class={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${badge.class}`}>
      {badge.label}
    </span>
    {#if row.state === 'blocked'}
      <span class="ml-1 text-xs text-red-700">may already be refusing writes</span>
    {/if}
  </td>
  <td class="px-4 py-3 text-sm">
    {#if editor.editingOrgId !== row.orgId}
      <button
        type="button"
        class="rounded-lg border border-gray-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-gray-50"
        onclick={() => editor.startEdit(row)}
      >
        Edit
      </button>
      {#if editor.saveSuccessOrgId === row.orgId}
        <span class="ml-1 text-xs text-green-700" role="status">Saved</span>
      {/if}
    {/if}
  </td>
</tr>
{#if editor.editingOrgId === row.orgId}
  <PlatformAuditQuotaForm {row} {editor} />
{/if}
