<!--
  @pv-stable: the props contract ({ unreadCount }) is final. Story 68.5: the notifications bell
  and unread badge extracted from AppShell's header so it is individually replaceable by resolved
  path. AppShell still decides whether to render it (it is hidden with the primary nav).
  Story 68.7 (S4): renders the `shell.utility` surface: the bell is PV's `badge-link` item; a
  composed app can change it or add its own items here.
-->
<script lang="ts">
  import NavDisclosure from '$lib/navigation/NavDisclosure.svelte'
  import NavEntry from '$lib/navigation/NavEntry.svelte'
  import { renderSurface } from '$lib/navigation/build-surface.js'

  let { unreadCount = 0 }: { unreadCount?: number } = $props()

  const items = $derived(renderSurface('shell.utility', { pathname: '', unreadCount }))
  const ITEM_CLASS = 'rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700'
</script>

{#each items as item (item.id)}
  {#if item.kind === 'badge-link' && item.href !== undefined && item.children.length === 0}
    <a
      class="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      aria-label={item.label}
      href={item.href}
    >
      <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
        />
      </svg>
      {#if unreadCount > 0}
        <span
          class="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-medium text-white"
        >
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      {/if}
    </a>
  {:else if item.children.length > 0}
    <NavDisclosure node={item} class={ITEM_CLASS} />
  {:else}
    <NavEntry node={item} class={ITEM_CLASS} />
  {/if}
{/each}
