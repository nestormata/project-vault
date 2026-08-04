<script lang="ts">
  // Shared by both reveal pages (17.1's session-bound `/shares/[token]` and 17.2's
  // unauthenticated `/external-shares/[token]`) — same "who shared what, and until when" summary,
  // parameterized by the caller's own sharer-label and expiry-note text since the two recipient
  // types disclose different sharer identity (email vs. display name) and TTL semantics.
  let {
    sharedByLabel,
    credentialName,
    fieldKey,
    attributeKeys = null,
    expiresAt,
    expiryNote,
  }: {
    sharedByLabel: string
    credentialName: string
    fieldKey: string | null
    // Story 20.5 (review patch): lets the recipient tell a bounded share apart from an ordinary
    // whole-credential share before they even reveal it — mirrors the sharer-facing
    // `shareScopeLabel` helper on the credential detail page.
    attributeKeys?: string[] | null
    expiresAt: string
    expiryNote: string
  } = $props()

  // Bugfix (dev-auto review): must be `$derived`, not a plain `const` — in Svelte 5 runes mode a
  // bare `const` computed from `$props()` is evaluated once at component creation and will not
  // update if the page reuses this mounted component across a client-side navigation to a
  // different share token (SvelteKit reuses component instances for same-route param changes).
  const scopeNote = $derived(
    fieldKey
      ? ` (field: ${fieldKey})`
      : attributeKeys && attributeKeys.length > 0
        ? ` (fields: ${attributeKeys.join(', ')})`
        : ''
  )
</script>

<p class="text-sm text-slate-700">
  <strong>{sharedByLabel}</strong> shared
  <strong>{credentialName}</strong>{scopeNote} with you.
</p>
<p class="mt-2 text-xs text-slate-500">
  Expires {new Date(expiresAt).toLocaleString()} · {expiryNote}
</p>
