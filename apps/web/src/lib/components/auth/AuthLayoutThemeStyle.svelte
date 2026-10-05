<script lang="ts">
  import type { Snippet } from 'svelte'

  let { preAuthThemeCss, children }: { preAuthThemeCss: string | null; children?: Snippet } =
    $props()
</script>

{#if preAuthThemeCss}
  <!--
    Story 16.4 AC-3: same delivery pattern `(app)/+layout.svelte` already uses for 16.2 —
    `<svelte:element>` with a plain auto-escaped text-node child, NEVER the html-injection
    directive (this repo's static-hardening gate forbids that directive entirely).
  -->
  <svelte:element this={"style"}>{preAuthThemeCss}</svelte:element>
{/if}
{@render children?.()}
