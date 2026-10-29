<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.14: the new password field of the recovery form as one replaceable region. The typed
  // value is bound to the recovery state owned by the page content and is never given to a point.
  let {
    value = $bindable(),
    data,
  }: { value: string; data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region auth.recovery-detail.password -->
<RegionFragment>
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="recovery-new-password">New password</label>
    <input
      class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2"
      id="recovery-new-password"
      type="password"
      autocomplete="new-password"
      aria-describedby="recovery-new-password-help"
      bind:value
      minlength="12"
      required
    />
    <FormHelpText id="recovery-new-password-help" kind="secret" /><InjectionPoint
      name="auth.recovery-detail.password"
      {data}
    />
    <p class="text-sm text-slate-600">Use at least 12 characters.</p>
  </div>
</RegionFragment>
