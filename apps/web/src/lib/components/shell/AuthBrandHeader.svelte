<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { asset } from '$app/paths'
</script>

<div class="mb-8 flex flex-col items-center gap-2 text-center">
  <img src={asset('/logo-mark.png')} alt="" width="276" height="240" class="h-20 w-auto" />
  <p class="text-xl font-bold text-brand-600">{m.brand_name()}</p>
  <p class="text-slate-600">Run complex projects. Miss nothing.</p>
</div>
