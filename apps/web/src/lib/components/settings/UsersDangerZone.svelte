<script lang="ts">
  import type { OrgUser } from '$lib/api/org-users.js'
  import type { UsersActions } from './users-actions.svelte.js'
  import RotationTransferPanel from '$lib/components/members/RotationTransferPanel.svelte'

  // Story 69.10: the "Danger zone" of one user row (deactivate, remove, the rotation follow-ups, the
  // transfer panel, erasure request). The table's `actions` owns the state; this only renders it.
  let { actions, user, orgRole }: { actions: UsersActions; user: OrgUser; orgRole: string } =
    $props()
</script>

{#snippet WarningIcon()}
  <svg aria-hidden="true" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
    <path
      d="M8.257 3.099c.765-1.36 2.72-1.36 3.486 0l6.516 11.59c.75 1.334-.213 2.985-1.743 2.985H3.484c-1.53 0-2.493-1.651-1.743-2.985L8.257 3.1zM11 13a1 1 0 10-2 0 1 1 0 002 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
    />
  </svg>
{/snippet}

<!--
  AC-14: destructive actions (Deactivate, Remove, Request erasure) are grouped
  in a bordered/labeled "Danger zone" with a warning icon next to each label, so
  destructiveness isn't conveyed by text color alone (WCAG 1.4.1).
-->
<div
  class="mt-1 flex w-full flex-col items-end gap-1 border-r-2 border-red-300 pr-2"
  data-testid="danger-zone"
>
  <p class="text-[10px] font-semibold uppercase tracking-wide text-red-700">Danger zone</p>
  {#if user.status === 'active'}
    <button
      class="inline-flex items-center gap-1 text-sm font-medium text-amber-700 underline disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      disabled={actions.busyKey === user.userId}
      onclick={() => actions.onDeactivateOrgUser(user)}
    >
      {@render WarningIcon()}
      Deactivate account
    </button>
    {#if actions.rotationBlockedUserId === user.userId}
      <button
        class="inline-flex items-center gap-1 text-sm font-medium text-amber-700 underline disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled={actions.busyKey === user.userId}
        onclick={() => actions.onAbandonRotationsAndDeactivate(user)}
      >
        {@render WarningIcon()}
        Abandon unfinished rotations and deactivate
      </button>
      <button
        class="inline-flex items-center gap-1 text-sm font-medium text-amber-700 underline disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled={actions.busyKey === user.userId}
        onclick={() => actions.openTransfer(user, 'deactivate')}
      >
        {@render WarningIcon()}
        Transfer unfinished rotations and deactivate
      </button>
    {/if}
  {/if}
  <button
    class="inline-flex items-center gap-1 text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
    type="button"
    disabled={actions.busyKey === user.userId}
    onclick={() => actions.onRemoveOrgUser(user)}
  >
    {@render WarningIcon()}
    Remove from organization
  </button>
  {#if actions.rotationBlockedRemovalUserId === user.userId}
    <button
      class="inline-flex items-center gap-1 text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      disabled={actions.busyKey === user.userId}
      onclick={() => actions.onAbandonRotationsAndRemove(user)}
    >
      {@render WarningIcon()}
      Abandon unfinished rotations and remove
    </button>
    <button
      class="inline-flex items-center gap-1 text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      disabled={actions.busyKey === user.userId}
      onclick={() => actions.openTransfer(user, 'remove')}
    >
      {@render WarningIcon()}
      Transfer unfinished rotations and remove
    </button>
  {/if}
  {#if actions.transferOpen?.userId === user.userId}
    <RotationTransferPanel
      subjectEmail={user.email}
      actionLabel={actions.transferOpen.action}
      targets={actions.transferTargetsFor(user)}
      saving={actions.transferSaving}
      error={actions.transferError}
      onconfirm={(toUserId) => actions.onConfirmTransfer(user, toUserId)}
      oncancel={() => (actions.transferOpen = null)}
    />
  {/if}
  {#if actions.blockedRemoval[user.userId]}
    <p class="text-xs text-amber-800" role="alert">
      {actions.blockedRemoval[user.userId]}
    </p>
  {/if}

  <!-- Story 8.7 AC-A4/K: admin+ can request erasure -->
  {#if orgRole === 'owner' || orgRole === 'admin'}
    <button
      class="inline-flex items-center gap-1 text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      onclick={() => actions.openErasureRequest(user)}
    >
      {@render WarningIcon()}
      Request erasure
    </button>
  {/if}
</div>
