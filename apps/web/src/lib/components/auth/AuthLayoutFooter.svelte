<script lang="ts">
  import type { Snippet } from 'svelte'
  import Footer from '$lib/components/shell/Footer.svelte'

  let { children }: { children?: Snippet } = $props()
</script>

{@render children?.()}
<div class="mx-auto mt-6 max-w-xl">
  <Footer />
</div>
