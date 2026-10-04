<script lang="ts">
  import type { ProjectInvitation } from '$lib/api/invitations.js'

  // Story 69.4: the pending-invitations table. The page owns the data and the revoke mutation; it
  // keeps the table's container element and renders its `project.members.invitations` point after
  // this.
  let {
    invitations,
    revokingId,
    onRevoke,
  }: {
    invitations: readonly ProjectInvitation[]
    revokingId: string | null
    onRevoke: (invitation: ProjectInvitation) => void
  } = $props()

  function relativeExpiry(expiresAt: string): string {
    const ms = new Date(expiresAt).getTime() - Date.now()
    if (ms <= 0) return 'expired'
    const hours = Math.round(ms / (60 * 60 * 1000))
    if (hours < 24) return `expires in ${hours}h`
    return `expires in ${Math.round(hours / 24)}d`
  }
</script>

<table class="min-w-full text-left text-sm">
  <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
    <tr>
      <th class="px-4 py-3 font-semibold">Email</th>
      <th class="px-4 py-3 font-semibold">Role</th>
      <th class="px-4 py-3 font-semibold">Expiry</th>
      <th class="px-4 py-3 font-semibold"></th>
    </tr>
  </thead>
  <tbody>
    {#each invitations as invitation (invitation.id)}
      <tr class="border-b border-slate-100 last:border-b-0">
        <td class="px-4 py-3">{invitation.email}</td>
        <td class="px-4 py-3 text-slate-600">{invitation.roleToAssign}</td>
        <td class="px-4 py-3 text-slate-600">{relativeExpiry(invitation.expiresAt)}</td>
        <td class="px-4 py-3 text-right">
          <button
            class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            disabled={revokingId === invitation.id}
            onclick={() => onRevoke(invitation)}
          >
            Revoke
          </button>
        </td>
      </tr>
    {:else}
      <tr>
        <td class="px-4 py-6 text-center text-slate-600" colspan="4"> No pending invitations. </td>
      </tr>
    {/each}
  </tbody>
</table>
