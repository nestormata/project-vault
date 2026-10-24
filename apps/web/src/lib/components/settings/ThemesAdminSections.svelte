<script lang="ts">
  import type { ThemesPageData } from '../../../routes/(app)/settings/themes/+page.server.js'
  import type { Snippet } from 'svelte'
  import ThemesOrgDefaultCard from './ThemesOrgDefaultCard.svelte'
  import ThemesReloadCard from './ThemesReloadCard.svelte'

  // Story 69.12: the admin/owner sections of the themes page, one sub-region per card (reload
  // themes, the organization default). Each card owns its own state. `data` is the page's
  // `__inject` map.
  let {
    canReload,
    themes,
    orgId,
    orgDefaultThemeName,
    data,
    children,
  }: {
    canReload: boolean
    themes: ThemesPageData['themes']
    orgId: ThemesPageData['orgId']
    orgDefaultThemeName: ThemesPageData['orgDefaultThemeName']
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if canReload}
  <ThemesReloadCard {data} />

  <ThemesOrgDefaultCard {themes} {orgId} {orgDefaultThemeName} {data} />
{/if}
