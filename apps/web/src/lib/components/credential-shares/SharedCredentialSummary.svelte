<script lang="ts">
  // Shared by both reveal pages (17.1's session-bound `/shares/[token]` and 17.2's
  // unauthenticated `/external-shares/[token]`) — same "who shared what, and until when" summary,
  // parameterized by the caller's own sharer-label and expiry-note text since the two recipient
  // types disclose different sharer identity (email vs. display name) and TTL semantics.
  let {
    sharedByLabel,
    credentialName,
    fieldKey,
    expiresAt,
    expiryNote,
  }: {
    sharedByLabel: string
    credentialName: string
    fieldKey: string | null
    expiresAt: string
    expiryNote: string
  } = $props()
</script>

<p class="text-sm text-slate-700">
  <strong>{sharedByLabel}</strong> shared
  <strong>{credentialName}</strong>{fieldKey ? ` (field: ${fieldKey})` : ''} with you.
</p>
<p class="mt-2 text-xs text-slate-500">
  Expires {new Date(expiresAt).toLocaleString()} · {expiryNote}
</p>
