<script lang="ts">
  const fail = (): never => {
    throw new Error('contribution render failure')
  }
  fail()
</script>

<p>never</p>
