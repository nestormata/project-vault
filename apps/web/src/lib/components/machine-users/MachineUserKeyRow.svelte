<script lang="ts">
  import type { ApiKeyMetadata } from '@project-vault/shared'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { formatDate } from './machine-user-detail.js'
  import type { MachineUserKeys } from './machine-user-keys.svelte.js'

  // Story 69.14: one API key of the list, with its rotate, emergency revoke and revoke controls.
  let {
    apiKey,
    canManage,
    keys,
  }: { apiKey: ApiKeyMetadata; canManage: boolean; keys: MachineUserKeys } = $props()
</script>

<li class="rounded-xl border border-slate-200 p-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div>
      <p class="font-medium text-slate-950">{apiKey.name}</p>
      <p class="text-sm text-slate-600">
        Expires {formatDate(apiKey.expiresAt)} · Last used {formatDate(apiKey.lastUsedAt)}
      </p>
    </div>
    {#if apiKey.isRevoked}
      <span class="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
        Revoked
      </span>
    {:else}
      <span class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
        Active
      </span>
    {/if}
  </div>

  {#if canManage && !apiKey.isRevoked}
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <label class="flex items-center gap-2 text-sm text-slate-700">
        Overlap (min)
        <input
          class="w-20 rounded-lg border border-slate-300 px-2 py-1"
          type="number"
          min="1"
          max="1440"
          value={keys.overlapFor(apiKey.id)}
          aria-describedby={`rotation-overlap-help-${apiKey.id}`}
          oninput={(event) => keys.setOverlap(apiKey.id, (event.target as HTMLInputElement).value)}
        />
        <FormHelpText id={`rotation-overlap-help-${apiKey.id}`} kind="date" />
      </label>
      <ConfirmDeleteButton
        label="Rotate"
        confirmLabel="Confirm rotate?"
        pendingLabel="Rotating…"
        onConfirm={() => keys.rotate(apiKey.id, apiKey.name)}
      />
      <ConfirmDeleteButton
        label="Emergency revoke"
        confirmLabel="Confirm emergency revoke?"
        pendingLabel="Revoking…"
        onConfirm={() => keys.emergencyRevoke(apiKey.id, apiKey.name)}
      />
      <ConfirmDeleteButton
        label="Revoke"
        confirmLabel="Confirm revoke?"
        pendingLabel="Revoking…"
        onConfirm={() => keys.revoke(apiKey.id)}
      />
    </div>
  {/if}
</li>
