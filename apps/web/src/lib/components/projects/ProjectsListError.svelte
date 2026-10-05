<script lang="ts">
  import type { Snippet } from 'svelte'

  let { errorMessage, children }: { errorMessage: string | null; children?: Snippet } = $props()
</script>

{#if errorMessage}
  <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
    {errorMessage}
  </p>
{/if}
{@render children?.()}
