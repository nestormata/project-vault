<!--
  @pv-stable: the props contract ({ node, projectId, credentialId? }) is final. Story 68.7 (S14,
  design rule 8): a page's back link, the `back` surface's node `node`, in PV's default back-link
  style. Reusable by CM pages after inserting their own `back` node.
-->
<script lang="ts">
  import NavLink from '$lib/navigation/NavLink.svelte'

  let {
    node,
    projectId = '',
    credentialId = '',
  }: { node: string; projectId?: string; credentialId?: string } = $props()
</script>

<NavLink
  surface="back"
  {node}
  {projectId}
  {credentialId}
  class="inline-block font-medium text-slate-700 underline"
/>
