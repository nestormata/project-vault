<!--
  Shared dormancy-threshold `<option>` set (30/60/90/180 days) reused by both the machine-key and
  user dormancy-threshold `<select>` controls on /settings/users (Story 8.7 AC group I mirrors
  Story 8.6's machine-key control exactly) — matches RoleSelectOptions.svelte's "shared <option>
  set, differing onchange stays on the parent <select>" precedent.
-->
<script lang="ts">
  // Story 68.1 AC-7: no props or logic; the TypeScript script block lets svelte-check type this
  // component and its importers (a script-less component has no type declaration).
</script>

<option value="">Choose a new threshold…</option>
<option value={30}>30 days</option>
<option value={60}>60 days</option>
<option value={90}>90 days</option>
<option value={180}>180 days</option>
