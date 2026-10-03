<script lang="ts" generics="N extends InjectionPointName">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import type {
    InjectionEntry,
    InjectionPointExtras,
    InjectionPointName,
  } from './injection-points.js'

  // `entries` is set by the build transform (`config/injection-plugins.ts`), which imports the
  // point's virtual module statically. It is optional so the untransformed source type-checks.
  // `props` carries only the page's own entity (`project`, `credential`, ...): the route id and
  // params every point receives are read here, so a page never has to spell them out.
  let {
    name,
    props,
    data,
    entries = [],
    fallback,
  }: {
    name: N
    props?: InjectionPointExtras<N>
    data?: Record<string, readonly unknown[]> | undefined
    entries?: readonly InjectionEntry[]
    fallback?: Snippet
  } = $props()

  const contributed = $derived(data?.[name] ?? [])
  const standard = $derived({ routeId: page.route?.id ?? '', params: page.params ?? {} })
</script>

{#if entries.length === 0}
  {@render fallback?.()}
{:else}
  {#each entries as entry, index (entry.id)}
    <entry.component {...standard} {...props} data={contributed[index] ?? null} />
  {/each}
{/if}
