<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { HandoffFlow } from './handoff-flow.svelte.js'

  // Story 69.11: the confirm prompt of the sign-in handoff (who signs in to which organization, a
  // Confirm button and a way out). `flow` owns the phase, so the buttons are inert while a confirm
  // is in flight.
  let {
    flow,
    data,
  }: {
    flow: HandoffFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region auth.handoff.confirm -->
<RegionFragment>
  <div class="space-y-4">
    <h1 class="text-2xl font-bold">{m.auth_handoff_confirm_heading()}</h1>
    <!-- AC1.6: long attacker-influenced values wrap rather than breaking layout; never sliced. -->
    <p class="break-words text-slate-700">
      {m.auth_handoff_confirm_prompt({
        accountLabel: flow.accountLabel,
        organizationName: flow.organizationName,
      })}
    </p>
    {#if flow.phase === 'network_error'}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {m.auth_handoff_network_error()}
      </p>
    {/if}
    <!-- Story 60.4 AC4: "Not me" is a link (it navigates) to /login, secondary-styled, beside
    Confirm in a wrapping row. It makes no API call — the pending state and its httpOnly cookie
    simply expire on their existing 120s TTL. Inert while a confirm is in flight so the user
    cannot land on /login while a session cookie is being set. -->
    <div class="flex flex-wrap gap-3">
      <button
        class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled={flow.phase === 'submitting'}
        onclick={() => void flow.handleConfirm()}
      >
        {flow.phase === 'submitting'
          ? m.auth_handoff_confirming()
          : m.auth_handoff_confirm_button()}
      </button>
      <a
        class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50"
        class:pointer-events-none={flow.phase === 'submitting'}
        class:opacity-60={flow.phase === 'submitting'}
        href={resolve('/login')}
        aria-disabled={flow.phase === 'submitting' ? 'true' : undefined}
        tabindex={flow.phase === 'submitting' ? -1 : undefined}
        onclick={flow.preventCancelWhileSubmitting}
      >
        {m.auth_handoff_cancel()}
      </a><InjectionPoint name="auth.handoff.confirm" {data} />
    </div>
  </div>
</RegionFragment>
