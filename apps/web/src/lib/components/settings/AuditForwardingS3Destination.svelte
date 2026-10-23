<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: where the S3-compatible forwarder writes (bucket and region), as one region.
  let {
    bucket = $bindable(),
    region = $bindable(),
    data,
  }: {
    bucket: string
    region: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-forwarding.s3-destination -->
<RegionFragment>
  <label class="flex flex-col text-sm text-slate-700" for="s3-bucket">
    Bucket
    <input
      id="s3-bucket"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      bind:value={bucket}
      aria-describedby="s3-bucket-help"
    />
    <FormHelpText id="s3-bucket-help" kind="text" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="s3-region">
    Region
    <input
      id="s3-region"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      bind:value={region}
      aria-describedby="s3-region-help"
    />
    <FormHelpText id="s3-region-help" kind="text" />
  </label><InjectionPoint name="settings.audit-forwarding.s3-destination" {data} />
</RegionFragment>
