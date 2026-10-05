<script lang="ts">
  import type { PageData } from '../../../routes/(app)/settings/language/$types.js'
  import type { SubmitFunction } from '@sveltejs/kit'
  import type { Snippet } from 'svelte'
  import { enhance } from '$app/forms'
  import { m } from '$lib/paraglide/messages.js'

  let {
    options,
    saving,
    handleSubmit,
    children,
  }: {
    options: PageData['options']
    saving: boolean
    handleSubmit: SubmitFunction
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
<ul class="mt-6 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
  {#each options as option (option.locale)}
    <li class="flex items-center justify-between px-6 py-4">
      <div>
        <p class="font-medium text-gray-900">{option.label}</p>
        {#if option.isCurrent}
          <p class="text-sm text-gray-500">{m.settings_language_current_label()}</p>
        {/if}
      </div>
      <form method="POST" action="?/updateLocale" use:enhance={handleSubmit}>
        <input type="hidden" name="locale" value={option.locale} />
        <button
          type="submit"
          class="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          disabled={option.isCurrent || saving}
        >
          {option.isCurrent ? 'Selected' : 'Select'}
        </button>
      </form>
    </li>
  {/each}
</ul>
