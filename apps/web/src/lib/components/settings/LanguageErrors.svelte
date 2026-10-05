<script lang="ts">
  import type { ActionData } from '../../../routes/(app)/settings/language/$types.js'
  import type { Snippet } from 'svelte'

  let {
    errorMessage,
    form,
    children,
  }: { errorMessage: string | null; form: ActionData; children?: Snippet } = $props()
</script>

{#if errorMessage}
  <p class="mt-4 text-sm text-red-600" role="alert">{errorMessage}</p>
{/if}
{#if form && 'error' in form && form.error}
  <p class="mt-4 text-sm text-red-600" role="alert">{form.error}</p>
{/if}
{@render children?.()}
