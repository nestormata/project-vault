<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import { resolve } from '$app/paths'
  import type { CredentialStatus } from '@project-vault/shared'
  import RotationBadge from '$lib/components/rotations/RotationBadge.svelte'

  // Story 69.10: one row of the credentials table (moved verbatim from the list component).
  let {
    credential,
    projectId,
  }: {
    credential: {
      id: string
      name: string
      status: CredentialStatus
      tags: readonly string[]
      expiresAt: string | null
      hasDependencies: boolean
      archivedAt: string | null
      activeRotation: {
        status: ComponentProps<typeof RotationBadge>['status']
        rotationId: string
      } | null
    }
    projectId: string
  } = $props()

  function statusClass(status: CredentialStatus): string {
    switch (status) {
      case 'active':
        return 'bg-emerald-100 text-emerald-800'
      case 'expiring':
        return 'bg-amber-100 text-amber-900'
      case 'expired':
        return 'bg-red-100 text-red-800'
    }
  }
  function formatDate(value: string | null): string {
    if (!value) return '—'
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
</script>

<tr class="border-b border-slate-100 last:border-b-0">
  <td class="px-4 py-3">
    <a
      class="font-semibold text-slate-950 underline"
      href={resolve(`/projects/${projectId}/credentials/${credential.id}`)}
    >
      {credential.name}
    </a>
    {#if credential.archivedAt}
      <span class="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700">
        Archived
      </span>
    {/if}
  </td>
  <td class="px-4 py-3">
    <span class={`rounded-full px-2 py-1 text-xs font-semibold ${statusClass(credential.status)}`}>
      {credential.status}
    </span>
  </td>
  <td class="px-4 py-3">
    <!-- Story 18.5 AC-1/AC-6: badge for a credential whose current rotation is
         badge-worthy (non-terminal); links to the same rotation detail page pattern
         used by the credential detail page's "View active rotation" link. -->
    {#if credential.activeRotation}
      <RotationBadge
        status={credential.activeRotation.status}
        href={`/projects/${projectId}/credentials/${credential.id}/rotations/${credential.activeRotation.rotationId}`}
      />
    {:else}
      —
    {/if}
  </td>
  <td class="px-4 py-3 text-slate-600">
    {credential.tags.length > 0 ? credential.tags.join(', ') : '—'}
  </td>
  <td class="px-4 py-3 text-slate-600">{formatDate(credential.expiresAt)}</td>
  <td class="px-4 py-3 text-slate-600">
    {credential.hasDependencies ? 'Yes' : '—'}
  </td>
</tr>
