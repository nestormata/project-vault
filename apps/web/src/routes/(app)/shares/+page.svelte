<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import SharesIndexHeader from '$lib/components/shares/SharesIndexHeader.svelte'
  import SharesIndexList from '$lib/components/shares/SharesIndexList.svelte'

  let { data } = $props()
</script>

<svelte:head>
  <title>{m.shares_index_page_title()}</title>
</svelte:head>

<InjectionPoint name="shares.home.before" data={data?.__inject} />
<InjectionPoint name="shares.home.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <!-- @region shares.home.header -->
  <SharesIndexHeader>
    <InjectionPoint name="shares.home.header" data={data?.__inject} />
  </SharesIndexHeader>

  <!-- @region shares.home.list -->
  <SharesIndexList
    items={data.items}
    total={data.total}
    page={data.page}
    pageSize={data.pageSize}
    displayStatus={data.displayStatus}
  >
    <InjectionPoint name="shares.home.list" data={data?.__inject} />
  </SharesIndexList>
</section>
<InjectionPoint name="shares.home.after" data={data?.__inject} />
