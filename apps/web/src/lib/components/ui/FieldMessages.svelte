<!--
  @pv-stable: the props contract ({ id, hint, helpId, error }) is final (Story 72.3). The hint and
  the error text of a field or a group: `<id>-help` (or `helpId`) and `<id>-error`.
-->
<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { errorIdOf, helpIdOf } from './field-ids.js'

  let { id, hint, helpId, error }: { id: string; hint?: string; helpId?: string; error?: string } =
    $props()
</script>

{#if hint}
  <FormHelpText id={helpIdOf(id, helpId)} text={hint} />
{/if}{#if error}
  <p id={errorIdOf(id)} class="text-sm text-red-700" role="alert">{error}</p>
{/if}
