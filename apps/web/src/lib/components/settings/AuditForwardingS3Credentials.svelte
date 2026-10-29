<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the S3 access key pair (never redisplayed; the form clears both after a save).
  let {
    accessKeyId = $bindable(),
    secretAccessKey = $bindable(),
    data,
  }: {
    accessKeyId: string
    secretAccessKey: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-forwarding.s3-credentials -->
<RegionFragment>
  <label class="flex flex-col text-sm text-slate-700" for="s3-access-key">
    Access key ID
    <input
      id="s3-access-key"
      type="password"
      autocomplete="off"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      bind:value={accessKeyId}
      aria-describedby="s3-access-key-help"
    />
    <FormHelpText id="s3-access-key-help" kind="secret" />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="s3-secret-key">
    Secret access key
    <input
      id="s3-secret-key"
      type="password"
      autocomplete="off"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      bind:value={secretAccessKey}
      aria-describedby="s3-secret-key-help"
    />
    <FormHelpText id="s3-secret-key-help" kind="secret" />
  </label><InjectionPoint name="settings.audit-forwarding.s3-credentials" {data} />
</RegionFragment>
