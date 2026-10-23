<script lang="ts">
  import type { OrgUser } from '$lib/api/org-users.js'
  import type { UsersActions } from './users-actions.svelte.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the erasure-request form of one user row. The table's `actions` owns the state.
  let { actions, user }: { actions: UsersActions; user: OrgUser } = $props()
</script>

{#if actions.erasureOpenFor === user.userId}
  <div class="mt-2 w-64 rounded-lg border border-slate-200 bg-slate-50 p-3 text-left text-xs">
    <label class="flex flex-col gap-1" for={`erasure-reason-${user.userId}`}>
      Reason
      <textarea
        id={`erasure-reason-${user.userId}`}
        class="rounded border border-slate-300 px-2 py-1"
        maxlength="2000"
        bind:value={actions.erasureReason}
        aria-describedby={`erasure-reason-help-${user.userId}`}></textarea>
      <FormHelpText id={`erasure-reason-help-${user.userId}`} kind="text" />
    </label>
    <label class="mt-2 flex flex-col gap-1" for={`erasure-requestedBy-${user.userId}`}>
      Requested by
      <input
        id={`erasure-requestedBy-${user.userId}`}
        type="text"
        class="rounded border border-slate-300 px-2 py-1"
        maxlength="500"
        bind:value={actions.erasureRequestedBy}
        aria-describedby={`erasure-requested-by-help-${user.userId}`}
      />
      <FormHelpText id={`erasure-requested-by-help-${user.userId}`} kind="text" />
    </label>
    <div class="mt-2 flex gap-2">
      <button
        type="button"
        class="rounded-lg border border-slate-400 px-2 py-1 text-xs font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={actions.erasureSaving ||
          !actions.erasureReason.trim() ||
          !actions.erasureRequestedBy.trim()}
        onclick={() => actions.onSubmitErasureRequest(user)}
      >
        {actions.erasureSaving ? 'Submitting…' : 'Submit request'}
      </button>
      <button
        type="button"
        class="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700"
        onclick={() => (actions.erasureOpenFor = null)}
      >
        Cancel
      </button>
    </div>
    {#if actions.erasureError}
      <p class="mt-1 text-red-700" role="alert">{actions.erasureError}</p>
    {/if}
  </div>
{/if}
