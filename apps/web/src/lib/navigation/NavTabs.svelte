<!--
  Story 68.7 (S12): an in-page tab bar (the notifications status tabs). A tab carries its query
  (`?status=…`) and is active by the context; a tab with children is a disclosure tab whose panel
  lists them.
-->
<script lang="ts">
  import NavDisclosure from './NavDisclosure.svelte'
  import { renderSurface } from './build-surface.js'

  let { status }: { status: string } = $props()

  const tabs = $derived(renderSurface('notifications.tabs', { pathname: '', status }))
  const tabClass = (active: boolean) =>
    `border-b-2 px-4 py-2 text-sm font-medium transition-colors ${active ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'}`
</script>

{#each tabs as tab (tab.id)}
  {#if tab.children.length > 0}
    <NavDisclosure node={tab} class={tabClass(tab.current)} />
  {:else}
    <a href="{tab.href}{tab.query}" class={tabClass(tab.active)}>
      {tab.label}
    </a>
  {/if}
{/each}
