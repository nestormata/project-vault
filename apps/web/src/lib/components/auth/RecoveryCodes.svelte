<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.14: the one-time list of recovery codes shown after an MFA re-enrollment as one
  // replaceable region. The codes reach this region as a prop and never reach its point.
  let {
    codes,
    onContinue,
    data,
  }: {
    codes: readonly string[]
    onContinue: () => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region auth.recovery-detail.codes -->
<RegionFragment>
  <div class="space-y-4">
    <h1 class="text-2xl font-bold">Save your recovery codes</h1>
    <p class="text-slate-600">
      Store these somewhere safe. Each code can be used once if you lose access to your
      authenticator app. They won't be shown again.
    </p>
    <ul
      class="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm"
    >
      {#each codes as code (code)}
        <li>{code}</li>
      {/each}
    </ul>
    <button
      class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
      type="button"
      onclick={onContinue}
    >
      Continue to login
    </button><InjectionPoint name="auth.recovery-detail.codes" {data} />
  </div>
</RegionFragment>
