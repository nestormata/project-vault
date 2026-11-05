<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import CliDeviceForm from '$lib/components/cli-device/CliDeviceForm.svelte'
  import type { ActionData, PageData } from './$types.js'

  const { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head>
  <title>{m.cli_device_page_title()} | {m.brand_name()}</title>
</svelte:head>

<InjectionPoint name="cli.device.before" data={data?.__inject} />
<InjectionPoint name="cli.device.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-xl px-4 py-8">
  <!-- @region cli.device.form -->
  <CliDeviceForm
    code={data.code}
    isPlatformOperator={data.isPlatformOperator}
    outcome={form?.outcome}
  >
    <InjectionPoint name="cli.device.form" data={data?.__inject} />
  </CliDeviceForm>
</div>
<InjectionPoint name="cli.device.after" data={data?.__inject} />
