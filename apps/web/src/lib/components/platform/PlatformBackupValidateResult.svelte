<script lang="ts">
  import type { BackupsController } from './backups-controller.svelte.js'

  let { filename, controller }: { filename: string; controller: BackupsController } = $props()
</script>

{#if controller.validateResults.has(filename)}
  {@const vr = controller.validateResult(filename)}
  {#if vr}
    <tr class="bg-slate-50 border-b border-slate-100">
      <td colspan="7" class="px-4 py-3 text-sm">
        <div class="flex items-center gap-2 mb-2">
          <span class="font-semibold">
            {vr.valid ? '✓ Valid' : '✗ Invalid'}
          </span>
          {#if vr.checksum === 'mismatch'}
            <span class="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
              ⚠ Checksum mismatch — this backup file may be corrupted or tampered with.
            </span>
          {/if}
        </div>
        <ul class="space-y-1 text-xs text-slate-600">
          <li>Checksum: {vr.checksum === 'match' ? '✓ Match' : '✗ Mismatch'}</li>
          <li>Secrets: {vr.assetsPresent.credentials ? '✓' : '✗ Missing'}</li>
          <li>Projects: {vr.assetsPresent.projects ? '✓' : '✗ Missing'}</li>
          <li>Users: {vr.assetsPresent.users ? '✓' : '✗ Missing'}</li>
          <li>Audit events: {vr.assetsPresent.auditEvents ? '✓' : '✗ Missing'}</li>
          <li>
            Data erasure requests: {vr.assetsPresent.dataErasureRequests ? '✓' : '✗ Missing'}
          </li>
        </ul>
      </td>
    </tr>
  {/if}
{/if}
{#if controller.validateErrors.get(filename)}
  <tr class="bg-red-50 border-b border-slate-100">
    <td colspan="7" class="px-4 py-2 text-sm text-red-700">
      {controller.validateErrors.get(filename)}
    </td>
  </tr>
{/if}
