<script lang="ts">
  import type { Snippet } from 'svelte'

  // Story 69.4: the load-error banner of the settings audit page. It renders nothing without a
  // message; `children` is the page's `settings.audit.error` injection point, rendered last.
  let { message, children }: { message: string | null; children?: Snippet } = $props()
</script>

{#if message}
  <p class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
    {message}
  </p>
{/if}{@render children?.()}
