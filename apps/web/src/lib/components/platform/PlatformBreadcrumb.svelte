<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import type { Snippet } from 'svelte'

  interface Crumb {
    label: string
    href?: string
  }

  interface Props {
    allowed: boolean
    trail: Crumb[]
    maxWidth?: string
    children: Snippet
  }

  let { allowed, trail, maxWidth = 'max-w-5xl', children }: Props = $props()
</script>

{#if !allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class={`mx-auto ${maxWidth} px-4 py-8`}>
    <nav class="mb-4 text-sm text-gray-500">
      {#each trail as crumb, i (crumb.label)}
        {#if i > 0}<span class="mx-2">›</span>{/if}
        {#if crumb.href}
          <a href={resolve(crumb.href)} class="hover:underline">{crumb.label}</a>
        {:else}
          <span>{crumb.label}</span>
        {/if}
      {/each}
    </nav>
    {@render children()}
  </div>
{/if}
