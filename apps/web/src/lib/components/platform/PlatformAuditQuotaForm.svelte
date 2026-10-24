<script lang="ts">
  import type { AuditStorageOrgRow } from '$lib/api/platform.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import type { AuditQuotaEditor } from './audit-quota-editor.svelte.js'

  let { row, editor }: { row: AuditStorageOrgRow; editor: AuditQuotaEditor } = $props()
</script>

<tr class="border-b border-slate-100 bg-slate-50 last:border-b-0">
  <td colspan="7" class="px-4 py-4">
    <form
      class="flex flex-wrap items-end gap-3"
      onsubmit={(e) => {
        e.preventDefault()
        void editor.submit(row)
      }}
    >
      <label class="flex flex-col text-xs text-gray-700">
        Quota
        <span class="mt-1 flex gap-1">
          <input
            type="number"
            min="0"
            step="any"
            bind:value={editor.quotaValue}
            placeholder="Unlimited"
            aria-describedby="audit-quota-help-{row.orgId}"
            class="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
          />
          <select
            bind:value={editor.quotaUnit}
            aria-describedby="audit-quota-unit-help-{row.orgId}"
            class="rounded border border-gray-300 px-1 py-1 text-sm"
          >
            <option value="MB">MB</option>
            <option value="GB">GB</option>
          </select>
        </span>
        <FormHelpText
          id="audit-quota-help-{row.orgId}"
          kind="text"
          text="Leave blank for unlimited. Enter a value and choose MB or GB."
        />
        <FormHelpText
          id="audit-quota-unit-help-{row.orgId}"
          kind="select"
          text="Unit for the quota value."
        />
      </label>
      <label class="flex flex-col text-xs text-gray-700">
        Write rate (writes/min)
        <input
          type="number"
          min="0"
          step="1"
          bind:value={editor.rateValue}
          placeholder="Unlimited"
          aria-describedby="audit-rate-help-{row.orgId}"
          class="mt-1 w-32 rounded border border-gray-300 px-2 py-1 text-sm"
        />
        <FormHelpText
          id="audit-rate-help-{row.orgId}"
          kind="text"
          text="Leave blank for unlimited writes per minute."
        />
      </label>
      <button
        type="submit"
        disabled={editor.saving}
        class="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
      >
        {editor.saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        class="rounded-xl border border-gray-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
        onclick={() => editor.cancelEdit()}
      >
        Cancel
      </button>
    </form>

    {#if editor.belowUsagePending}
      <div
        class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        role="alert"
      >
        This organization is currently using {formatBytes(row.bytesUsed)}. Setting a lower quota
        will immediately block its audit writes until usage drops. Continue?
        <button
          type="button"
          class="ml-2 rounded border border-amber-400 px-2 py-1 font-semibold"
          onclick={() => void editor.submit(row, { skipBelowUsageCheck: true })}
        >
          Continue anyway
        </button>
      </div>
    {/if}

    {#if editor.overcommitPending}
      <div
        class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
        role="alert"
      >
        {`This would allocate an estimated ${formatBytes(editor.overcommitPending.estimatedPhysicalBytes)} of physical storage against a ${formatBytes(editor.overcommitPending.instanceLimitBytes)} instance limit. Continue anyway?`}
        <button
          type="button"
          class="ml-2 rounded border border-amber-400 px-2 py-1 font-semibold"
          onclick={() =>
            void editor.submit(row, { acknowledgeOvercommit: true, skipBelowUsageCheck: true })}
        >
          Continue anyway
        </button>
      </div>
    {/if}

    {#if editor.saveError}
      <p class="mt-3 text-xs text-red-700" role="alert">{editor.saveError}</p>
    {/if}
    {#if editor.saveMfaError}
      <MfaAwareErrorAlert
        message={editor.saveMfaError}
        class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
      />
    {/if}
  </td>
</tr>
