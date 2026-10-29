<!--
  @pv-stable: takes no props (Story 72.5).
  Story 72.5: renders the pending confirmation of `$lib/state/confirm.svelte.ts` on the shared
  `ConfirmDialog`. Mounted once in the (app) layout. Renders nothing while no confirmation waits.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { beforeNavigate } from '$app/navigation'
  import {
    cancelAllConfirms,
    getActiveConfirm,
    registerConfirmHost,
    settleConfirm,
  } from '$lib/state/confirm.svelte.js'
  import ConfirmDialog from './ConfirmDialog.svelte'

  const active = $derived(getActiveConfirm())
  const request = $derived(active?.request ?? null)
  let answered = false

  $effect(() => {
    // Each request gets a fresh dialog instance (see the key below), unanswered.
    if (active) answered = false
  })

  onMount(() => registerConfirmHost())

  // A confirmation belongs to the page that raised it: leaving the page answers it with no.
  beforeNavigate(() => cancelAllConfirms())

  function answer(value: boolean) {
    if (answered) return
    answered = true
    settleConfirm(value)
  }
</script>

{#if request}
  {#key active?.seq}
    <ConfirmDialog
      open={true}
      id="app-confirm"
      title={request.title}
      message={request.message}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      variant={request.variant}
      typedValue={request.typedValue}
      typedLabel={request.typedLabel}
      onconfirm={() => answer(true)}
      oncancel={() => answer(false)}
    />
  {/key}
{/if}
