<script lang="ts">
  import type { Snippet } from 'svelte'
  import AuthBrandHeader from '$lib/components/shell/AuthBrandHeader.svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="mx-auto max-w-3xl">
  <AuthBrandHeader />
</div>
{@render children?.()}
