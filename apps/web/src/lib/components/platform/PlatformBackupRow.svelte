<script lang="ts">
  import type { BackupListItem } from '$lib/api/platform.js'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import type { BackupsController } from './backups-controller.svelte.js'
  import PlatformBackupRestore from './PlatformBackupRestore.svelte'
  import PlatformBackupValidateResult from './PlatformBackupValidateResult.svelte'

  let { backup, controller }: { backup: BackupListItem; controller: BackupsController } = $props()

  function statusLabel(status: 'running' | 'succeeded' | 'failed'): string {
    return { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' }[status]
  }
</script>

<tr class="border-b border-slate-100 last:border-b-0">
  <td class="px-4 py-3 font-mono text-xs text-slate-800">{backup.filename}</td>
  <td class="px-4 py-3 text-sm text-slate-600">{new Date(backup.timestamp).toLocaleString()}</td>
  <td class="px-4 py-3 text-sm">
    {#if backup.status === 'failed'}
      <span class="font-semibold text-red-700" title={backup.errorMessage ?? ''}>
        Failed{backup.errorMessage ? ` — ${backup.errorMessage}` : ''}
      </span>
    {:else if backup.status === 'running'}
      <span class="text-amber-700">Running…</span>
    {:else}
      <span class="text-green-700">{statusLabel(backup.status)}</span>
    {/if}
  </td>
  <td class="px-4 py-3 text-sm text-slate-600">{formatBytes(backup.sizeBytes)}</td>
  <td class="px-4 py-3 text-sm">
    {#if backup.verified === 'valid'}
      <span class="text-green-700">Valid ✓</span>
    {:else if backup.verified === 'invalid'}
      <span class="text-red-700">Invalid ✗</span>
    {:else}
      <span class="text-slate-500">Unverified</span>
    {/if}
  </td>
  <td class="px-4 py-3 text-sm text-slate-600">{backup.keyVersion ?? '—'}</td>
  <td class="px-4 py-3 text-sm">
    <div class="flex gap-2">
      {#if backup.status !== 'running'}
        <button
          type="button"
          class="rounded border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
          onclick={() => void controller.validate(backup.filename)}
        >
          Validate
        </button>
        <button
          type="button"
          class="rounded border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
          onclick={() => controller.openRestore(backup.filename)}
        >
          Restore
        </button>
      {/if}
    </div>
  </td>
</tr>

<PlatformBackupValidateResult filename={backup.filename} {controller} />
<PlatformBackupRestore filename={backup.filename} {controller} />
