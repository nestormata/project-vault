<script lang="ts">
  import type { Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'

  let { children }: { children?: Snippet } = $props()
</script>

<h1 class="mt-2 text-2xl font-bold text-gray-900">{m.settings_language_page_heading()}</h1>
<p class="text-gray-500">{m.settings_language_page_description()}</p>
<p class="mt-2 text-sm text-gray-400">{m.settings_language_coverage_note()}</p>
{@render children?.()}
