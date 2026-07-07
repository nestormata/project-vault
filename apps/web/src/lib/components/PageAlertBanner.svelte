<!--
  Full-width red alert banner shown in place of a route's body for page-level failure states
  (sealed vault, entity not found/inaccessible). Shared verbatim across the dashboard, credential
  detail, and rotation detail pages — `backHref`/`backLabel` are omitted for states with nowhere
  sensible to go back to (e.g. the dashboard's own sealed-vault state).
-->
<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    title,
    message,
    backHref,
    backLabel,
  }: {
    title: string
    message: string
    backHref?: string
    backLabel?: string
  } = $props()
</script>

<div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
  <h1 class="text-xl font-semibold text-red-900">{title}</h1>
  <p class="mt-2 text-red-800">{message}</p>
  {#if backHref && backLabel}
    <a class="mt-4 inline-block font-medium text-slate-950 underline" href={resolve(backHref)}>
      {backLabel}
    </a>
  {/if}
</div>
