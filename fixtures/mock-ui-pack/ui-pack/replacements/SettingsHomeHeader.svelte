<script lang="ts">
  // Story 69.5, M4 on a region component that was inline markup of a PV page before the audit
  // (the settings home header): wraps PV's original through `pv-original:` and adds its own marker.
  import type { Snippet } from 'svelte'
  import Original from 'pv-original:$lib/components/settings/SettingsHomeHeader.svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<span data-testid="mock-settings-home">mock-ui-pack:m4-settings-home</span>
<Original>{@render children?.()}</Original>
