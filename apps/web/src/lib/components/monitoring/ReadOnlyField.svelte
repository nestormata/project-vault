<!--
  A single label+value pair in a monitored-asset detail page's read-only view (shown to viewers
  instead of the editable form — AC-I1). Shared across the certificates/domains/services/
  service-endpoints detail pages.
-->
<script lang="ts">
  let { label, value }: { label: string; value: string } = $props()
</script>

<div>
  <p class="text-sm font-medium text-slate-900">{label}</p>
  <p class="text-slate-700">{value}</p>
</div>
