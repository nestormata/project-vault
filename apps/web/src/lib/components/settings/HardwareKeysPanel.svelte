<script lang="ts">
  import {
    completeWebauthnRegistration,
    deleteWebauthnCredential,
    listWebauthnCredentials,
    renameWebauthnCredential,
    startWebauthnRegistration,
    type AuthUser,
    type WebauthnCredentialSummary,
  } from '$lib/api/auth.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { m } from '$lib/paraglide/messages.js'
  import { startHardwareKeyRegistration } from './webauthn-browser.js'

  let { initialUser }: { initialUser: AuthUser } = $props()

  let user = $derived(initialUser)
  let credentials = $state<WebauthnCredentialSummary[]>([])
  let name = $state('Security key')
  let errorMessage = $state<string | null>(null)
  let isSubmitting = $state(false)
  let renamingId = $state<string | null>(null)
  let renameValue = $state('')
  let confirmingId = $state<string | null>(null)

  function mapError(error: unknown, fallback: string): string {
    if (error instanceof ApiClientError) return error.message
    return error instanceof Error ? error.message : fallback
  }

  async function refreshList() {
    if (!user.mfaEnrolled) return
    const listed = await listWebauthnCredentials(fetch)
    credentials = listed.credentials
  }

  $effect(() => {
    if (!user.mfaEnrolled) return
    void refreshList().catch((error: unknown) => {
      errorMessage = mapError(error, m.security_hardware_keys_list_failed())
    })
  })

  async function registerKey() {
    if (isSubmitting || !user.mfaEnrolled) return
    isSubmitting = true
    errorMessage = null
    try {
      const started = await startWebauthnRegistration(fetch)
      const attestation = await startHardwareKeyRegistration(started.options)
      await completeWebauthnRegistration(fetch, {
        challengeId: started.challengeId,
        name,
        attestation,
      })
      name = 'Security key'
      await refreshList()
    } catch (error) {
      errorMessage = mapError(error, m.security_hardware_keys_register_failed())
    } finally {
      isSubmitting = false
    }
  }

  async function saveRename(id: string) {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    try {
      await renameWebauthnCredential(fetch, id, renameValue)
      renamingId = null
      await refreshList()
    } catch (error) {
      errorMessage = mapError(error, m.security_hardware_keys_rename_failed())
    } finally {
      isSubmitting = false
    }
  }

  async function removeKey(id: string) {
    if (isSubmitting) return
    isSubmitting = true
    errorMessage = null
    try {
      await deleteWebauthnCredential(fetch, id)
      confirmingId = null
      await refreshList()
    } catch (error) {
      errorMessage = mapError(error, m.security_hardware_keys_remove_failed())
    } finally {
      isSubmitting = false
    }
  }
</script>

<div class="mt-8 space-y-4 rounded-2xl border border-slate-200 bg-white p-6">
  <h2 class="text-lg font-semibold text-slate-950">{m.security_hardware_keys_heading()}</h2>
  {#if !user.mfaEnrolled}
    <p class="text-sm text-slate-600">{m.security_hardware_keys_requires_totp()}</p>
  {:else}
    <p class="text-sm text-slate-600">{m.security_hardware_keys_secret_guidance()}</p>
    <p class="text-sm text-slate-600">{m.security_hardware_keys_lost_guidance()}</p>

    {#if credentials.length === 0}
      <p class="text-sm text-slate-600">{m.security_hardware_keys_empty()}</p>
    {:else}
      <ul class="space-y-3">
        {#each credentials as key (key.id)}
          <li class="rounded-xl border border-slate-200 p-4">
            {#if renamingId === key.id}
              <form
                class="space-y-3"
                onsubmit={(event) => {
                  event.preventDefault()
                  void saveRename(key.id)
                }}
              >
                <label class="block text-sm font-medium text-slate-700" for={`rename-${key.id}`}>
                  {m.security_hardware_keys_name_label()}
                </label>
                <input
                  id={`rename-${key.id}`}
                  class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2"
                  maxlength="64"
                  bind:value={renameValue}
                />
                <div class="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSubmitting}
                  >
                    {m.security_hardware_keys_save_name()}
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 font-medium text-slate-900"
                    onclick={() => {
                      renamingId = null
                    }}
                  >
                    {m.security_hardware_keys_cancel()}
                  </button>
                </div>
              </form>
            {:else}
              <p class="font-medium text-slate-950">{key.name}</p>
              <div class="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 font-medium text-slate-900"
                  onclick={() => {
                    renamingId = key.id
                    renameValue = key.name
                    confirmingId = null
                  }}
                >
                  {m.security_hardware_keys_rename()}
                </button>
                {#if confirmingId === key.id}
                  <button
                    type="button"
                    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSubmitting}
                    onclick={() => void removeKey(key.id)}
                  >
                    {m.security_hardware_keys_confirm_remove()}
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 font-medium text-slate-900"
                    onclick={() => {
                      confirmingId = null
                    }}
                  >
                    {m.security_hardware_keys_cancel()}
                  </button>
                {:else}
                  <button
                    type="button"
                    class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 font-medium text-slate-900"
                    onclick={() => {
                      confirmingId = key.id
                    }}
                  >
                    {m.security_hardware_keys_remove()}
                  </button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <form
      class="space-y-3"
      onsubmit={(event) => {
        event.preventDefault()
        void registerKey()
      }}
    >
      <label class="block text-sm font-medium text-slate-700" for="hardware-key-name">
        {m.security_hardware_keys_name_label()}
      </label>
      <input
        id="hardware-key-name"
        class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2"
        maxlength="64"
        bind:value={name}
      />
      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}
      <button
        type="submit"
        class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        disabled={isSubmitting}
      >
        {isSubmitting
          ? m.security_hardware_keys_registering()
          : m.security_hardware_keys_register()}
      </button>
    </form>
  {/if}
</div>
