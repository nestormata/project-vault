<script lang="ts">
  import { resolve } from '$app/paths'
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError, isMfaRequiredError } from '$lib/api/client.js'
  import { patchThemeSelection, triggerThemeReload } from '$lib/api/themes.js'
  import { setAppliedTheme } from '$lib/state/theme.svelte.js'
  import type { ThemesPageData } from './+page.server.js'

  const { data }: { data: ThemesPageData } = $props()

  let selected = $state(data.selected)
  let saving = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)

  // Story 16.3 — "Reload themes" admin/owner section. The button is shown to every admin/owner
  // (AC-4 Dev Notes: there is no side-effect-free way to know MFA-enrollment status ahead of
  // time for this endpoint), and MFA-required state is detected reactively from the click's own
  // 403 mfa_required response, not a load-time precheck.
  let reloading = $state(false)
  let reloadMessage = $state<string | null>(null)
  let reloadError = $state<string | null>(null)
  let reloadMfaRequired = $state(false)

  async function handleReload() {
    if (reloading) return
    reloading = true
    reloadMessage = null
    reloadError = null
    try {
      const result = await triggerThemeReload(fetch)
      const loadedCount = result.loaded.length
      if (result.failed.length === 0) {
        reloadMessage = `Reloaded ${loadedCount} theme(s).`
      } else {
        const failedList = result.failed.map((f) => `${f.file} — ${f.reason}`).join('; ')
        reloadMessage = `Reloaded ${loadedCount} theme(s). ${result.failed.length} failed: ${failedList}.`
      }
      // AC-2/AC-3: refresh the theme list below so any newly loaded theme appears without a
      // manual page refresh.
      await invalidateAll()
    } catch (err) {
      if (isMfaRequiredError(err)) {
        // AC-4: replace the button with an inline notice rather than a generic error banner.
        reloadMfaRequired = true
      } else if (err instanceof ApiClientError && err.status === 429) {
        // AC-5: do not retry automatically; tell the admin to wait.
        reloadError = 'Too many reload attempts — wait a moment and try again.'
      } else if (err instanceof ApiClientError && err.status === 503) {
        // AC-7: fail-closed audit write — the UI must not claim success.
        reloadError = 'Reload failed — please try again.'
      } else if (err instanceof ApiClientError && err.status === 403) {
        // AC-8: defense-in-depth for a stale session whose role was downgraded after page load.
        reloadError = 'You do not have permission to reload themes.'
      } else {
        reloadError = 'Reload failed — please try again.'
      }
    } finally {
      reloading = false
    }
  }

  // AC-3 second edge case: a stored selection that no longer appears in the currently-compiled
  // set is shown as its own distinct, disabled "currently unavailable" option — never silently
  // defaulted to "Default" in this radio group, so the user isn't confused about what's actually
  // stored vs. what's currently applied (that distinction is the (app) layout's orphaned-theme
  // notice, a separate concern from this page).
  const availableNames = $derived(data.themes.map((theme) => theme.name))
  const orphanedSelection = $derived(
    selected !== null && !availableNames.includes(selected) ? selected : null
  )

  async function selectTheme(themeName: string | null) {
    if (saving) return
    saving = themeName ?? 'base'
    errorMessage = null
    try {
      const result = await patchThemeSelection(fetch, themeName)
      // AC-2: pessimistic — only apply the new theme app-wide after the server confirms the
      // save, never optimistically on click.
      selected = result.themeName
      setAppliedTheme(result.themeName)
    } catch {
      errorMessage = 'Failed to save your theme selection, try again.'
    } finally {
      saving = null
    }
  }
</script>

<svelte:head>
  <title>Themes | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <a href={resolve('/settings')} class="text-sm text-indigo-600 hover:text-indigo-800">← Settings</a
  >
  <h1 class="mt-2 text-2xl font-bold text-gray-900">Themes</h1>
  <p class="mt-2 text-gray-500">Choose which installed theme is active for your view.</p>

  {#if errorMessage}
    <p class="mt-4 text-sm text-red-600" role="alert">{errorMessage}</p>
  {/if}

  {#if data.errorMessage}
    <p class="mt-4 text-sm text-red-600" role="alert">{data.errorMessage}</p>
  {:else}
    <ul class="mt-6 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
      {#each data.themes as theme (theme.name)}
        <li class="flex items-center justify-between px-6 py-4">
          <label class="flex items-center gap-3">
            <input
              type="radio"
              name="theme"
              value={theme.name}
              checked={selected === theme.name || (selected === null && theme.name === 'base')}
              disabled={saving !== null}
              onchange={() => selectTheme(theme.name === 'base' ? null : theme.name)}
            />
            <span class="font-medium text-gray-900">{theme.label}</span>
          </label>
        </li>
      {/each}
      {#if orphanedSelection}
        <li class="flex items-center justify-between px-6 py-4">
          <label class="flex items-center gap-3 text-gray-400">
            <input type="radio" name="theme" checked disabled />
            <span class="font-medium">{orphanedSelection} (currently unavailable)</span>
          </label>
        </li>
      {/if}
    </ul>
  {/if}

  {#if data.canReload}
    <div class="mt-8 rounded-lg border border-gray-200 bg-white px-6 py-4">
      <h2 class="text-lg font-semibold text-gray-900">Reload themes</h2>
      <p class="mt-1 text-sm text-gray-500">
        Re-scan the themes directory and compile any newly installed custom theme files.
      </p>

      {#if reloadMessage}
        <p
          class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          role="status"
        >
          {reloadMessage}
        </p>
      {/if}
      {#if reloadError}
        <p
          class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          {reloadError}
        </p>
      {/if}

      {#if reloadMfaRequired}
        <p class="mt-4 text-sm text-amber-700">MFA required to reload themes.</p>
      {:else}
        <button
          type="button"
          class="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={reloading}
          onclick={() => void handleReload()}
        >
          {reloading ? 'Reloading…' : 'Reload themes'}
        </button>
      {/if}
    </div>
  {/if}
</div>
