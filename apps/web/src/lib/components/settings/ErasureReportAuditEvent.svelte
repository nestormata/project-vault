<script lang="ts">
  // Story 69.11: the closing audit-event line of the compliance report.
  let { auditEventId }: { auditEventId: string | null | undefined } = $props()
</script>

<p class="mt-4 text-xs text-slate-500">Audit event: {auditEventId ?? '—'}</p>
