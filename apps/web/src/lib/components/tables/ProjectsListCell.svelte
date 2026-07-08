<!--
  Shared "empty state or wrapped <ul>" shell for a per-user project-memberships table cell,
  reused by /settings/users (editable role selects) and /settings/audit/access-report (read-only
  projectName: role rows) — same shared-wrapper-plus-snippet-children pattern as DataTable.svelte.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let { projects, children }: { projects: unknown[]; children: Snippet } = $props()
</script>

{#if projects.length === 0}
  <span class="text-slate-400">No project memberships</span>
{:else}
  <ul class="space-y-1">
    {@render children()}
  </ul>
{/if}
