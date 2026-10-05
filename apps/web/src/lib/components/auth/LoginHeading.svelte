<script lang="ts">
  import type { Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="space-y-2">
  <h1 class="text-3xl font-bold">{m.auth_login_page_heading()}</h1>
  <p class="text-slate-600">{m.auth_login_page_description()}</p>
</div>
{@render children?.()}
