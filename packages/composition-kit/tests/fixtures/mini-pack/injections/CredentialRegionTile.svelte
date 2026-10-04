<!-- Story 69.2: a fill at a REGION point of the credential detail page (`credential.detail.shares`,
     rendered inside PV's CredentialSharesRegion), opted in to behavior with `hostRoutes`. It shows what
     its load saw. -->
<script lang="ts">
  let { data = null }: { data?: { who?: string } | null } = $props()
</script>

<div data-testid="inject-credential-tile" data-marker="PV_INJECT_CREDENTIAL_MARKER_2d9c71">
  {data?.who ?? 'credential:none'}
</div>
