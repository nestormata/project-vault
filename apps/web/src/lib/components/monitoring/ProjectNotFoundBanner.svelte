<!--
  Shown at the top of a monitored-asset list page (certificates/domains/services/service-endpoints)
  when the parent project itself was not found or the caller lacks access to it. Identical across
  every asset type, so it lives here once instead of being copy-pasted into each list page.
-->
<script lang="ts">
  // Story 68.1 AC-7: no props or logic; the TypeScript script block lets svelte-check type this
  // component and its importers (a script-less component has no type declaration).
</script>

<div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
  <p class="text-red-800">This project was not found or you do not have access.</p>
</div>
