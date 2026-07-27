<script lang="ts">
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import type { SubmitFunction } from '@sveltejs/kit'
  import { setLocale } from '$lib/paraglide/runtime.js'
  import { m } from '$lib/paraglide/messages.js'
  import { localeToApplyFromActionResult } from './locale-settings-model.js'
  import type { ActionData, PageData } from './$types.js'

  const { data, form }: { data: PageData; form: ActionData } = $props()

  let saving = $state(false)
  let errorMessage = $state<string | null>(null)

  const handleSubmit: SubmitFunction = () => {
    saving = true
    errorMessage = null
    return async ({ result, update }) => {
      saving = false
      // Story 15.1 AC 9 — only switch the client-rendered locale AFTER the server confirms the
      // save (never optimistically before): a fail-closed audit rollback on the server must
      // never leave the client showing a locale that was never actually persisted. Re-reading the
      // server response (not the clicked value) as source of truth also naturally resolves the
      // AC 2 double-click race — the last PATCH to resolve determines the final UI state.
      const localeToApply = localeToApplyFromActionResult(result)
      if (localeToApply) {
        await setLocale(localeToApply, { reload: false })
      } else if (result.type === 'failure') {
        errorMessage = (result.data?.['error'] as string) ?? m.settings_language_save_error()
      }
      await update()
    }
  }
</script>

<svelte:head>
  <title>{m.settings_language_page_title()} | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <a href={resolve('/settings')} class="text-sm text-indigo-600 hover:text-indigo-800">← Settings</a
  >
  <h1 class="mt-2 text-2xl font-bold text-gray-900">{m.settings_language_page_heading()}</h1>
  <p class="text-gray-500">{m.settings_language_page_description()}</p>
  <p class="mt-2 text-sm text-gray-400">{m.settings_language_coverage_note()}</p>

  {#if errorMessage}
    <p class="mt-4 text-sm text-red-600" role="alert">{errorMessage}</p>
  {/if}
  {#if form && 'error' in form && form.error}
    <p class="mt-4 text-sm text-red-600" role="alert">{form.error}</p>
  {/if}

  <ul class="mt-6 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
    {#each data.options as option (option.locale)}
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
</div>
