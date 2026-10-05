<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import AssetListHeader from './AssetListHeader.svelte'

  // Story 69.6: a monitored-asset list page's header card (certificates, domains, services) as one
  // replaceable region. `description` is the card's copy; `children` is the page's own injection
  // point, rendered right after the card.
  let {
    description,
    children,
    ...header
  }: Omit<ComponentProps<typeof AssetListHeader>, 'children'> & {
    description: string
    children?: Snippet
  } = $props()
</script>

<AssetListHeader {...header}>{description}</AssetListHeader>{@render children?.()}
