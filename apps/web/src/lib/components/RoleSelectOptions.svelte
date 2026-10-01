<!--
  Shared role `<option>` set for the project-role `<select>` used in both the project members
  page and the org settings users page. Rendered inside a parent `<select>`; the differing
  `onchange` handlers stay inline on that `<select>`.
-->
<script lang="ts">
  // Story 68.1 AC-7: no props or logic; the TypeScript script block lets svelte-check type this
  // component and its importers (a script-less component has no type declaration).
</script>

<option value="admin">admin</option>
<option value="member">member</option>
<option value="viewer">viewer</option>
