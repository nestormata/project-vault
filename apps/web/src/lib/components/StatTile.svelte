<!--
  One labelled figure (`<dt>`/`<dd>`) inside a `<dl>`. The three tile families of the dashboard and the
  project page differ in their classes only, so the variant picks them; the markup is otherwise one.
  `children` is the value.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  type Variant = 'subtle' | 'subtle-compact' | 'card'

  let {
    label,
    variant = 'subtle',
    children,
  }: { label: string; variant?: Variant; children: Snippet } = $props()

  const classes = new Map<Variant, { tile: string; value: string }>([
    ['subtle', { tile: 'rounded-2xl bg-slate-50 p-4', value: 'text-2xl font-bold text-slate-950' }],
    [
      'subtle-compact',
      { tile: 'rounded-2xl bg-slate-50 p-4', value: 'text-lg font-bold text-slate-950' },
    ],
    [
      'card',
      {
        tile: 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm',
        value: 'mt-1 text-2xl font-bold text-slate-950',
      },
    ],
  ])
  const picked = $derived(classes.get(variant))
</script>

<div class={picked?.tile}>
  <dt class="text-sm text-slate-500">{label}</dt>
  <dd class={picked?.value}>{@render children()}</dd>
</div>
