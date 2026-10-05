<script lang="ts">
  import type { Snippet } from 'svelte'

  let { themeCss, children }: { themeCss: string; children?: Snippet } = $props()
</script>

{#if themeCss}
  <!--
    Story 16.2 AC-2: delivers 16.1's already CSS-injection-hardened compiled `[data-theme]` blocks
    as a real inline stylesheet element — `<svelte:element>` (a genuine runtime DOM element, never
    Svelte's own specially-compiled static `<style>` block) with its normal, auto-escaped text-node
    child, NEVER the `@html` directive (this repo's static-hardening gate forbids that entirely, see
    apps/web/src/lib/security/static-hardening.test.ts). Rendered directly in the initial SSR'd
    HTML (no onMount/client-only injection) so the very first page load already carries every
    compiled theme's CSS — the AC-2 "no FOUC" requirement — with the `data-theme` attribute below
    then simply toggling which block applies, live, no re-fetch needed.
  -->
  <svelte:element this={"style"}>{themeCss}</svelte:element>
{/if}
{@render children?.()}
