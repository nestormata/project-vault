<script lang="ts">
  // Story 69.4: the title block and the Invite toggle of the project members page. The page keeps
  // the title card element and `showInviteForm` state, and renders its `project.members.header`
  // point after this.
  let {
    canManage,
    showInviteForm,
    onToggleInvite,
  }: { canManage: boolean; showInviteForm: boolean; onToggleInvite: () => void } = $props()
</script>

<div>
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Members</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Project members</h1>
  <p class="mt-2 text-slate-600">Invite teammates and manage pending invitations.</p>
</div>
{#if canManage}
  <button
    class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
    type="button"
    onclick={onToggleInvite}
  >
    {showInviteForm ? 'Cancel' : 'Invite member'}
  </button>
{/if}
