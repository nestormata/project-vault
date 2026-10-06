<script lang="ts">
  // Story 69.6 M3 region point: `auth.register.form`, right after PV's registration form. Its load runs
  // for the anonymous visitor (there is no session), under PV's own hooks (rate limits, CSRF).
  let { data = null }: { data?: { marker?: string; runs?: number; session?: string } | null } =
    $props()
</script>

<p data-testid="mock-p6-register-form">
  mock-ui-pack:m3-p6-auth.register.form runs={data?.runs ?? 'none'} session={data?.session ??
    'none'}
</p>
