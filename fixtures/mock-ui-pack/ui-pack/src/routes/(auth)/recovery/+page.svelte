<script lang="ts">
  import { enhance } from '$app/forms'
  import type { PageProps } from './$types.js'

  let { data, form }: PageProps = $props()
</script>

<section data-testid="mock-recovery">
  <h1>mock-ui-pack:m1-recovery</h1>
  <p data-testid="mock-recovery-load">{data.mockRecovery}</p>
  <form method="POST" action="?/ping" use:enhance>
    <label for="mock-recovery-word">Word</label>
    <input id="mock-recovery-word" name="word" aria-describedby="mock-recovery-word-help" />
    <p id="mock-recovery-word-help">Any word, echoed back by this page action.</p>
    <button type="submit">Ping</button>
  </form>
  {#if form && 'mockPong' in form}
    <p data-testid="mock-recovery-pong">{form.mockPong}</p>
  {/if}
  {#if form && 'mockPingError' in form}
    <p data-testid="mock-recovery-ping-error">{form.mockPingError}</p>
  {/if}
</section>
