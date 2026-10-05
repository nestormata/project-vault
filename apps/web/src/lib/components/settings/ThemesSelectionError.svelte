<script lang="ts">
  import type { Snippet } from 'svelte'

  let { errorMessage, children }: { errorMessage: string | null; children?: Snippet } = $props()
</script>

{#if errorMessage}
  <p class="mt-4 text-sm text-red-600" role="alert">{errorMessage}</p>
{/if}
{@render children?.()}
