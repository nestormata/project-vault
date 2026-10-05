<script lang="ts">
  import type { Snippet } from 'svelte'
  import LoginForm from '$lib/components/auth/LoginForm.svelte'
  import { m } from '$lib/paraglide/messages.js'

  let {
    nativeLoginEnabled,
    nextPath,
    handleLocaleChange,
    children,
  }: {
    nativeLoginEnabled: boolean | null
    nextPath: string
    handleLocaleChange: () => void
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if nativeLoginEnabled === null}
  <!-- Story 23.2 AC-13: cold-start health-check failure with no last-known-good cache — a
  neutral, retryable state, never a password form rendered on a guess. -->
  <div class="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
    <p class="text-sm text-slate-700">{m.auth_login_temporarily_unavailable()}</p>
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
      type="button"
      onclick={() => window.location.reload()}
    >
      {m.auth_login_retry()}
    </button>
  </div>
{:else}
  <LoginForm {nextPath} onLocaleChange={handleLocaleChange} {nativeLoginEnabled} />
{/if}
