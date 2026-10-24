<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.11: the as-of date form of the access report page (a plain GET form).
  let {
    asOf,
    data,
  }: {
    asOf: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  function toDateInputValue(value: string | undefined): string {
    return value ? value.slice(0, 10) : ''
  }
</script>

<!-- @region settings.audit-access-report.form -->
<form method="GET" class="mt-6 flex flex-wrap items-end gap-3">
  <label class="flex flex-col text-sm text-slate-700" for="asOf">
    As of (leave blank for current state)
    <input
      id="asOf"
      name="asOf"
      type="date"
      class="rounded-lg border border-slate-300 px-2 py-1"
      aria-describedby="access-report-date-help"
      value={toDateInputValue(asOf)}
    />
  </label>
  <FormHelpText id="access-report-date-help" kind="date" />
  <button type="submit" class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
    Generate report
  </button><InjectionPoint name="settings.audit-access-report.form" {data} />
</form>
