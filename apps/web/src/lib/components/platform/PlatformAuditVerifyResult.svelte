<script lang="ts">
  import type { PlatformAuditVerifyResult } from '$lib/api/platform.js'

  // Story 69.10: the outcome of an integrity check (tampering list or the all-clear plus counts).
  let { result: r }: { result: PlatformAuditVerifyResult } = $props()
</script>

<div class="mt-4">
  {#if r.failedCount > 0}
    <div class="rounded-lg border border-red-300 bg-red-50 px-4 py-3" role="alert">
      <p class="font-semibold text-red-800">
        ⚠ Tampering detected — {r.failedCount} record(s) failed verification
      </p>
      <p class="mt-1 text-sm text-red-700">{r.summary}</p>
      <ul class="mt-2 space-y-1 text-xs text-red-700">
        {#each r.failed as f (f.id)}
          <li>{f.actionType} at {new Date(f.timestamp).toLocaleString()} (id: {f.id})</li>
        {/each}
        {#if r.failedTruncated}
          <li class="italic">…(truncated)</li>
        {/if}
      </ul>
    </div>
  {:else}
    <p class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
      ✓ {r.summary}
    </p>
  {/if}
  <p class="mt-2 text-xs text-slate-500">
    {r.rowsChecked} records checked, {r.passed} passed — verified at {new Date(
      r.verifiedAt
    ).toLocaleString()}
  </p>
</div>
