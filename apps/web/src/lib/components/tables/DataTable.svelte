<!--
  Shared list-table shell (rounded card + header row) reused by every project sub-resource list
  page (credentials, machine users, ...) — extracted to keep the wrapper/thead markup from being a
  byte-for-byte clone across pages (jscpd's zero-duplication gate), matching this app's existing
  "extract a shared child component" precedent (e.g. TotpCodeInput.svelte).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let { columns, children }: { columns: string[]; children: Snippet } = $props()
</script>

<div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
  <table class="min-w-full text-left text-sm">
    <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
      <tr>
        {#each columns as column (column)}
          <th class="px-4 py-3 font-semibold">{column}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {@render children()}
    </tbody>
  </table>
</div>
