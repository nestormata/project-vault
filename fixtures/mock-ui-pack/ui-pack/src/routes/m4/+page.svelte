<script lang="ts">
  import type { PageProps } from './$types.js'

  let { data }: PageProps = $props()
</script>

<h1>mock-ui-pack:m4</h1>
<p data-testid="m4-org">Org: {data.org}</p>
<p data-testid="m4-url">{data.url}</p>
