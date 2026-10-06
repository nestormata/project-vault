<script lang="ts">
  // Story 69.6 AC-5, M4 on a region component of a page that has no PV page test over it (the SSO
  // domains header): a FULL replacement. It renders neither PV's original nor its `children`, so the
  // region's injection point (PV renders it as the child of this component) is dropped with it. A fill
  // at `settings.sso-domains.header` therefore does not render; the sibling region
  // `settings.sso-domains.panel`, whose component is not replaced, keeps its fill.
</script>

<span data-testid="mock-sso-header">mock-ui-pack:m4-sso-header</span>
