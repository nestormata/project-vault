<script lang="ts">
  import NavLinkRow from '$lib/navigation/NavLinkRow.svelte'

  // Story 69.5: the settings audit page's link row as an indexed component (M4 replaces by resolved
  // path under `src/lib/components`; `NavLinkRow` lives outside that directory).
</script>

<NavLinkRow surface="settings.audit.links" />
