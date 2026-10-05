<script lang="ts">
  import type { Snippet } from 'svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'

  // Story 69.2: the "back to the secrets list" link at the foot of the page as one replaceable
  // region. `children` is the region's injection point, rendered right after the link.
  let { projectId, children }: { projectId: string; children?: Snippet } = $props()
</script>

<NavLink
  surface="back"
  node="back.project.credential"
  class="inline-block font-medium text-slate-700 underline"
  {projectId}
/>{@render children?.()}
