<script lang="ts">
  // Story 69.4 M3 region point: `settings.audit.header`, beside PV's own h1. Component only; it
  // renders the props PV hands the point (the viewer's role and whether PV let them in).
  let { orgRole = '', allowed = false }: { orgRole?: string; allowed?: boolean } = $props()
</script>

<p data-testid="mock-p5-audit-header">
  mock-ui-pack:m3-p5-settings.audit.header role={orgRole} allowed={String(allowed)}
</p>
