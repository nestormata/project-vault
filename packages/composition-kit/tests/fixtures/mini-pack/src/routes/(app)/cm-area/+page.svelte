<script lang="ts">
  import type { PageProps } from './$types.js'

  let { data }: PageProps = $props()
</script>

<h1>CM area for {data.who}: {data.price.amount} {data.price.currency}</h1>
