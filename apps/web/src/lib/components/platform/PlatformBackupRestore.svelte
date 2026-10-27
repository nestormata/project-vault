<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'
  import type { BackupsController } from './backups-controller.svelte.js'

  let { filename, controller }: { filename: string; controller: BackupsController } = $props()
</script>

{#if controller.restoreExpandedFilename === filename}
  <tr class="bg-amber-50 border-b border-slate-100">
    <td colspan="7" class="px-4 py-4">
      <div class="space-y-3">
        <p class="text-sm font-semibold text-amber-900">
          ⚠ Restore is destructive and irreversible. Type the exact filename to confirm.
        </p>
        <TypedConfirmInput
          expectedValue={filename}
          onMatchChange={(matches) => {
            controller.restoreTypedMatches = matches
          }}
          label="Type the exact filename to confirm"
          inputId="restore-typed-confirm"
        />
        <label class="block text-sm text-slate-700">
          Reason for restore (required)
          <textarea
            class="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
            rows="2"
            bind:value={controller.restoreReason}
            placeholder="Enter reason for restore"
            aria-describedby={`backup-restore-reason-help-${filename}`}></textarea>
          <FormHelpText id={`backup-restore-reason-help-${filename}`} kind="text" />
        </label>
        {#if controller.restoreError}
          <p class="text-sm text-red-700" role="alert">{controller.restoreError}</p>
        {/if}
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!controller.restoreEnabled || controller.restorePending}
            onclick={() => void controller.restore()}
          >
            {controller.restorePending ? 'Restoring…' : 'Restore'}
          </button>
          <button
            type="button"
            class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
            onclick={() => controller.closeRestore()}
          >
            Cancel
          </button>
        </div>
      </div>
    </td>
  </tr>
{/if}
