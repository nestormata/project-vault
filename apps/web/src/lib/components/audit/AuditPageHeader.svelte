<script lang="ts">
  import type { Snippet } from 'svelte'

  // Story 69.4: the title and description of the settings audit page. `children` is the page's
  // `settings.audit.header` injection point, rendered last so a replacement that ignores it drops
  // only the contribution, never PV's own markup.
  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="text-2xl font-bold text-gray-900">Audit &amp; Compliance</h1>
<p class="mt-2 text-gray-500">Search, export, and verify your organization's audit log.</p>
{@render children?.()}
