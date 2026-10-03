<!--
  @pv-stable: the props contract ({ hidePrimaryNav }) is final. Story 68.5: the brand block
  (logo, name, tagline) extracted from AppShell's header so it is individually replaceable by
  resolved path. The markup is byte-identical to what AppShell rendered inline.
-->
<script lang="ts">
  import { asset, resolve } from '$app/paths'

  let { hidePrimaryNav = false }: { hidePrimaryNav?: boolean } = $props()
</script>

<div>
  <div class="flex items-center gap-2">
    <img src={asset('/logo-mark.png')} alt="" width="276" height="240" class="h-8 w-auto" />
    {#if hidePrimaryNav}
      <p class="text-xl font-bold text-brand-600">Project Vault</p>
    {:else}
      <a class="text-xl font-bold text-brand-600" href={resolve('/dashboard')}>Project Vault</a>
    {/if}
  </div>
  <p class="text-sm text-slate-600">Run complex projects. Miss nothing.</p>
</div>
