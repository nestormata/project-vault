<script lang="ts">
  import type { withDescendants } from '$lib/navigation/build-surface.js'
  import type { Snippet } from 'svelte'
  import NavEntry from '$lib/navigation/NavEntry.svelte'

  let {
    isNotFound,
    status,
    heading,
    description,
    backLinks,
    children,
  }: {
    isNotFound: boolean
    status: number
    heading: string
    description: string
    backLinks: ReturnType<typeof withDescendants>
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
<main class="mx-auto max-w-2xl px-4 py-16 text-center">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
    {isNotFound ? '404' : `Error ${status}`}
  </p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">{heading}</h1>
  <p class="mt-4 text-slate-600">{description}</p>

  <nav aria-label="Error page navigation" class="mt-8">
    {#each backLinks as link (link.id)}<NavEntry
        node={link}
        class="inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white"
      />{/each}
  </nav>
</main>
