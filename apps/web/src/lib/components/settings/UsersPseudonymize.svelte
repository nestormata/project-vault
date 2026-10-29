<script lang="ts">
  import type { OrgUser } from '$lib/api/org-users.js'
  import type { UsersActions } from './users-actions.svelte.js'
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'

  // Story 69.10: the owner-only "Pseudonymize identity" control, its result and its typed-email
  // confirmation panel for one user row. The table's `actions` owns the state.
  let { actions, user, orgRole }: { actions: UsersActions; user: OrgUser; orgRole: string } =
    $props()
</script>

<!-- Story 8.7 AC-A4/J: owner-only pseudonymize -->
{#if orgRole === 'owner'}
  <button
    class="text-sm font-medium text-slate-700 underline disabled:cursor-not-allowed disabled:opacity-60"
    type="button"
    onclick={() => actions.openPseudonymize(user)}
  >
    Pseudonymize identity
  </button>
{/if}

{#if actions.pseudonymizeResults[user.userId]}
  <p class="max-w-xs text-left text-xs text-emerald-700">
    Identity pseudonymized as {actions.pseudonymizeResults[user.userId]?.alias}.
    {actions.pseudonymizeResults[user.userId]?.otherAffectedOrgCount === 0
      ? 'No other organizations affected.'
      : `This also affects how this user's audit history displays in ${actions.pseudonymizeResults[user.userId]?.otherAffectedOrgCount} other organization(s) they belong to.`}
  </p>
{/if}

{#if actions.pseudonymizeOpenFor === user.userId}
  <div class="mt-2 w-64 rounded-lg border border-red-200 bg-red-50 p-3 text-left text-xs">
    <p class="font-semibold text-red-800">This action is permanent and irreversible.</p>
    <p class="mt-1 text-slate-700">
      This may also affect how this user's audit history displays in other organizations they belong
      to — you'll see the exact count after confirming.
    </p>
    <div class="mt-2">
      <TypedConfirmInput
        expectedValue={user.email}
        label={`Type the exact email to confirm (${user.email})`}
        inputId={`pseudonymize-confirm-${user.userId}`}
        onMatchChange={(matches) => (actions.pseudonymizeMatches = matches)}
      />
    </div>
    <div class="mt-2 flex gap-2">
      <button
        type="button"
        class="rounded-lg border border-red-400 px-2 py-1 text-xs font-semibold text-red-800 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!actions.pseudonymizeMatches || actions.pseudonymizeSaving}
        onclick={() => actions.onConfirmPseudonymize(user)}
      >
        {actions.pseudonymizeSaving ? 'Pseudonymizing…' : 'Confirm pseudonymize'}
      </button>
      <button
        type="button"
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs text-slate-700"
        onclick={() => (actions.pseudonymizeOpenFor = null)}
      >
        Cancel
      </button>
    </div>
    {#if actions.pseudonymizeError}
      <p class="mt-1 text-red-700" role="alert">{actions.pseudonymizeError}</p>
    {/if}
  </div>
{/if}
