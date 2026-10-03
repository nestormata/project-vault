<!--
  @pv-stable: the props contract ({ user }) is final. Story 68.5: the role, org and sign-out
  cluster extracted from AppShell's header so it is individually replaceable by resolved path
  (a composed app can wrap this file through `pv-original:` and add its own header region).
  Story 68.7 (S6, Q11): the `account` surface (the account menu) renders from data: PV's sign-out
  action plus whatever a composed app adds. Role and org stay display text.
-->
<script lang="ts">
  import NavDisclosure from '$lib/navigation/NavDisclosure.svelte'
  import NavEntry from '$lib/navigation/NavEntry.svelte'
  import { renderSurface } from '$lib/navigation/build-surface.js'

  let { user }: { user: import('$lib/api/auth.js').AuthUser } = $props()

  // Story 28.4 AC2: $derived over `user` (not a bare message call) so the labels re-read the
  // current locale on every reactive update of this component. `user` is this component's reactive
  // prop, sourced from `(app)/+layout.svelte`'s `data.user`, which SvelteKit's `update()` (called by
  // the Settings → Language form after a no-reload setLocale()) refreshes with a new object reference
  // on every call; the message functions themselves read no Svelte-tracked signal.
  const items = $derived(renderSurface('account', { pathname: '', user }))
  const ITEM_CLASS = 'rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800'
</script>

<span>Role: {user.orgRole}</span>
<span class="max-w-full break-all">Org: {user.orgName}</span>
{#each items as item (item.id)}
  {#if item.kind === 'action' && item.onSelect !== undefined && item.children.length === 0}
    <button
      class="rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800"
      type="button"
      onclick={() => item.onSelect?.()}
    >
      {item.label}
    </button>
  {:else if item.children.length > 0}
    <NavDisclosure node={item} class={ITEM_CLASS} />
  {:else}
    <NavEntry node={item} class={ITEM_CLASS} />
  {/if}
{/each}
