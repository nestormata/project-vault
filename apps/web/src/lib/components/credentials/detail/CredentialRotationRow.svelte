<script lang="ts">
  import type { RotationSummary } from '@project-vault/shared'
  import { resolve } from '$app/paths'
  import {
    formatDateTime,
    rotationStatusBadgeClass,
  } from '$lib/components/rotations/rotation-copy.js'

  // Story 69.2: one row of the rotation history.
  let {
    rotation,
    projectId,
    credentialId,
  }: { rotation: RotationSummary; projectId: string; credentialId: string } = $props()
</script>

<li
  class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
>
  <a
    class="font-medium text-slate-950 underline"
    href={resolve(`/projects/${projectId}/credentials/${credentialId}/rotations/${rotation.id}`)}
  >
    initiated {formatDateTime(rotation.initiatedAt)}
  </a>
  <span class={rotationStatusBadgeClass(rotation.status)}>{rotation.status}</span>
  <span class="text-slate-600">completed {formatDateTime(rotation.completedAt)}</span>
  <span class="text-slate-600">
    {rotation.confirmedCount}/{rotation.itemCount} confirmed
  </span>
</li>
