<!--
  Story 43-17 AC-10 (FR102 third outcome): the small "transfer unfinished rotations" dialog on the
  org users page. Shown after a deactivate/remove was refused with 409 active_rotations. It lists
  the org's other active admins/owners (the caller included) and stays open on failure so the admin
  can pick another target or retry after `rotation_busy`; the confirm button stays disabled until
  a target is chosen.
-->
<script lang="ts">
  export type TransferTargetOption = { userId: string; email: string; displayName: string }

  let {
    subjectEmail,
    actionLabel,
    targets,
    saving,
    error,
    onconfirm,
    oncancel,
  }: {
    subjectEmail: string
    /** "deactivate" or "remove", used in the heading and confirm label. */
    actionLabel: 'deactivate' | 'remove'
    targets: TransferTargetOption[]
    saving: boolean
    error: string | null
    onconfirm: (transferToUserId: string) => void
    oncancel: () => void
  } = $props()

  let chosen = $state('')
  const selectId = $derived(`rotation-transfer-target-${subjectEmail}`)
</script>

<div
  class="mt-2 w-72 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-xs"
  role="dialog"
  aria-label={`Transfer ${subjectEmail}'s unfinished rotations`}
  data-testid="rotation-transfer-panel"
>
  <p class="font-semibold text-amber-900">
    Transfer {subjectEmail}'s unfinished rotations, then {actionLabel}
    {subjectEmail}
  </p>
  <p class="mt-1 text-slate-700">
    Every unfinished rotation keeps its status and history; only the owner changes. The new owner is
    notified.
  </p>
  {#if targets.length === 0}
    <p class="mt-2 text-slate-700" data-testid="rotation-transfer-empty">
      No other active admin is available to receive these rotations.
    </p>
  {:else}
    <label class="mt-2 flex flex-col gap-1" for={selectId}>
      New owner
      <select
        id={selectId}
        class="rounded border border-slate-300 bg-white px-2 py-1"
        bind:value={chosen}
        disabled={saving}
      >
        <option value="">Select an admin…</option>
        {#each targets as target (target.userId)}
          <option value={target.userId}>{target.displayName} ({target.email})</option>
        {/each}
      </select>
    </label>
  {/if}
  <div class="mt-2 flex gap-2">
    <button
      type="button"
      class="rounded-lg border border-amber-500 px-2 py-1 text-xs font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={chosen === '' || saving}
      onclick={() => onconfirm(chosen)}
    >
      {saving ? 'Transferring…' : `Transfer and ${actionLabel}`}
    </button>
    <button
      type="button"
      class="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700"
      onclick={oncancel}
    >
      Cancel
    </button>
  </div>
  {#if error}
    <p class="mt-1 text-red-700" role="alert">{error}</p>
  {/if}
</div>
