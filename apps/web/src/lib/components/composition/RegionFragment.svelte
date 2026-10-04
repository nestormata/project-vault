<script lang="ts">
  import type { Snippet } from 'svelte'

  // Story 69.3: renders its children and nothing else (no element, no whitespace), so a region
  // component can put a `<InjectionPoint>` right after the shared component it wraps, as a sibling,
  // without adding a DOM node to PV's own markup. It carries no behavior and no props besides the
  // children; the region component around it is the replaceable unit.
  let { children }: { children: Snippet } = $props()
</script>

{@render children()}
