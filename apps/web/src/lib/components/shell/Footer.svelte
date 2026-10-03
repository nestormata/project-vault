<script lang="ts">
  // Story 68.7 (S7): the footer's links are the `footer` surface's data (PV's GitHub and AGPL-3.0
  // source links; a composed app may change them, and pv-compose notes the AGPL source offer).
  import NavDisclosure from '$lib/navigation/NavDisclosure.svelte'
  import NavEntry from '$lib/navigation/NavEntry.svelte'
  import { renderSurface } from '$lib/navigation/build-surface.js'

  const links = $derived(renderSurface('footer', { pathname: '' }))
  const LINK_CLASS = 'text-brand-600 hover:text-brand-700'
  /** The whitespace main's markup had between two links. */
  const GAP = ' '
</script>

<footer
  class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4"
>
  <p>© {new Date().getFullYear()} Project Vault</p>
  {#each links as link, index (link.id)}{#if index > 0}{GAP}{/if}{#if link.children.length > 0}<NavDisclosure
        node={link}
        class={LINK_CLASS}
      />{:else}<NavEntry node={link} class={LINK_CLASS} />{/if}{/each}
</footer>
