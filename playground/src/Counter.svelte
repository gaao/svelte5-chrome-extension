<script>
  let { label = 'Counter', start = 0 } = $props();

  let count = $state(start);
  let doubled = $derived(count * 2);
  let history = $state([]);

  function increment() {
    count += 1;
    history.push(count);
  }
</script>

<div class="counter">
  <strong>{label}</strong>
  <button onclick={increment}>count is {count}</button>
  <span>doubled: {doubled}</span>
  <small>history length: {history.length}</small>
</div>

<style>
  .counter {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.25rem 0;
  }
</style>
