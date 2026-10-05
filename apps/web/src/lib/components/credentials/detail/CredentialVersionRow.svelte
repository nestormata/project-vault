<script lang="ts">
  import type { CredentialVersionSummary } from '@project-vault/shared'
  import { formatDateTime } from '$lib/components/rotations/rotation-copy.js'

  // Story 69.2: one row of the version history.
  let { version }: { version: CredentialVersionSummary } = $props()
</script>

<li class="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm">
  <span class="font-medium">Version {version.versionNumber}</span>
  <span class="text-slate-600">{formatDateTime(version.createdAt)}</span>
  {#if version.isCurrent}
    <span class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
      Current
    </span>
  {/if}
</li>
