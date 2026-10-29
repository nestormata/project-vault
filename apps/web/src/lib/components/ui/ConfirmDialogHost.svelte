<!--
  @pv-stable: takes no props (Story 72.5).
  Story 72.5: renders the pending confirmation of `$lib/state/confirm.svelte.ts` on the shared
  `ConfirmDialog`. Mounted once in the (app) layout. Renders nothing while no confirmation waits.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import {
    getActiveConfirm,
    registerConfirmHost,
    settleConfirm,
  } from '$lib/state/confirm.svelte.js'
  import ConfirmDialog from './ConfirmDialog.svelte'

  const request = $derived(getActiveConfirm())
  let open = $state(true)
  let answered = false

  $effect(() => {
    // A new request (a fresh dialog instance, see the key below) starts unanswered and open.
    if (request) {
      open = true
      answered = false
    }
  })

  onMount(() => registerConfirmHost())

  function answer(value: boolean) {
    if (answered) return
    answered = true
    settleConfirm(value)
  }
</script>

{#if request}
  {#key request}
    <ConfirmDialog
      bind:open
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
