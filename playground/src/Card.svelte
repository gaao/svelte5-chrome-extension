<script>
  let { title = 'Card', children } = $props();
</script>

<article>
  <header>{title}</header>
  <div class="body">
    {@render children?.()}
  </div>
</article>

<style>
  article {
    border: 1px solid #ff3e00;
    border-radius: 6px;
    overflow: hidden;
    margin: 0.75rem 0;
  }
  header {
    background: #ff3e00;
    color: white;
    padding: 0.3rem 0.6rem;
    font-weight: 600;
  }
  .body {
    padding: 0.6rem;
  }
</style>
