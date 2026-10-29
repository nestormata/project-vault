<script lang="ts">
  import type { OrgSsoDomain } from '$lib/api/org-sso-domains.js'
  import { m } from '$lib/paraglide/messages.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: one row of the SSO domains table, read or inline-edit. The list owns the edit state
  // (one row is edited at a time and every row's buttons share `busy`); the row edits it through
  // bindable props and callbacks.
  let {
    row,
    editing,
    editDomain = $bindable(),
    editProvider = $bindable(),
    editError,
    busy,
    onEdit,
    onCancel,
    onSave,
    onRemove,
  }: {
    row: OrgSsoDomain
    editing: boolean
    editDomain: string
    editProvider: string
    editError: string | null
    busy: boolean
    onEdit: (row: OrgSsoDomain) => void
    onCancel: () => void
    onSave: (row: OrgSsoDomain) => Promise<void>
    onRemove: (row: OrgSsoDomain) => Promise<void>
  } = $props()

  function formatCreatedAt(iso: string): string {
    return new Date(iso).toLocaleString()
  }
</script>

<tr
  class="border-b border-slate-100 align-top last:border-b-0"
  data-testid={editing ? `edit-row-${row.id}` : undefined}
>
  {#if editing}
    <td class="px-4 py-3">
      <input
        class="w-full rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
        aria-label="Domain"
        bind:value={editDomain}
        aria-describedby={`edit-domain-help-${row.id}`}
      />
      <FormHelpText id={`edit-domain-help-${row.id}`} text={m.form_help_sso_domain()} />
    </td>
    <td class="px-4 py-3">
      <input
        class="w-full rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
        aria-label="Provider name"
        bind:value={editProvider}
        aria-describedby={`edit-provider-help-${row.id}`}
      />
      <FormHelpText id={`edit-provider-help-${row.id}`} text={m.form_help_sso_provider_name()} />
    </td>
    <td class="px-4 py-3 text-slate-600">{formatCreatedAt(row.createdAt)}</td>
    <td class="px-4 py-3 text-right">
      <div class="flex flex-col items-end gap-1">
        <div class="flex gap-2">
          <button
            type="button"
            class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onclick={() => onSave(row)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" class="text-sm text-slate-500 underline" onclick={onCancel}>
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
          disabled={busy}
          onclick={() => onEdit(row)}
        >
          Edit
        </button>
        <button
          type="button"
          class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busy}
          onclick={() => onRemove(row)}
        >
          Remove
        </button>
      </div>
    </td>
  {/if}
</tr>
