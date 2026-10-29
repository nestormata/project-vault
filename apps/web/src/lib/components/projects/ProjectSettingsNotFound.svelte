<script lang="ts">
  import type { Snippet } from 'svelte'
  import ProjectNotFoundMessage from './ProjectNotFoundMessage.svelte'

  // Story 72-9: the settings page's not-found state (a missing or unreachable project).
  let { children }: { children?: Snippet } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <ProjectNotFoundMessage />
  {@render children?.()}
</div>
