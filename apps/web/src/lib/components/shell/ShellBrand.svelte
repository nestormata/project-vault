<!--
  @pv-stable: the props contract ({ hidePrimaryNav }) is final. Story 68.5: the brand block
  (logo, name, tagline) extracted from AppShell's header so it is individually replaceable by
  resolved path. Story 68.7 (S3): the home link is the `shell.brand` surface's data; while the
  primary nav is hidden (onboarding) it renders as plain text, exactly as before. Story 72.17 (R2):
  the tagline is the `shell_brand_tagline` message, so a host overlays one key instead of replacing
  this component.
-->
<script lang="ts">
  import { asset } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'
  import NavEntry from '$lib/navigation/NavEntry.svelte'
  import { renderSurface, withDescendants } from '$lib/navigation/build-surface.js'

  let { hidePrimaryNav = false }: { hidePrimaryNav?: boolean } = $props()

  const links = $derived(
    renderSurface('shell.brand', { pathname: '', hidePrimaryNav }).flatMap(withDescendants)
  )
</script>

<div>
  <div class="flex items-center gap-2">
    <img src={asset('/logo-mark.png')} alt="" width="276" height="240" class="h-8 w-auto" />
    {#each links as link (link.id)}
      {#if hidePrimaryNav}
        <p class="text-xl font-bold text-brand-600">{link.label}</p>
      {:else}
        <NavEntry node={link} class="text-xl font-bold text-brand-600" />
      {/if}
    {/each}
  </div>
  <p class="text-sm text-slate-600">{m.shell_brand_tagline()}</p>
</div>
