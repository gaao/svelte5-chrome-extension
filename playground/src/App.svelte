<script>
  import Counter from './Counter.svelte';
  import TodoList from './TodoList.svelte';
  import Nested from './Nested.svelte';
  import Card from './Card.svelte';

  let showExtra = $state(true);
  let keyed = $state(0);
  let promise = $state(loadData());

  function loadData() {
    return new Promise((resolve) => setTimeout(() => resolve('loaded payload'), 600));
  }
</script>

<main>
  <h1>Svelte 5 DevTools Playground</h1>

  <section>
    <Counter label="First" start={0} />
    <Counter label="Second" start={10} />
  </section>

  <section>
    <TodoList />
  </section>

  <!-- if block -->
  {#if showExtra}
    <section class="extra">
      <p>Extra content is visible</p>
      <Nested depth={0} />
    </section>
  {:else}
    <p>hidden</p>
  {/if}
  <button onclick={() => (showExtra = !showExtra)}>toggle if-block</button>

  <!-- key block -->
  {#key keyed}
    <section class="keyed">
      <p>keyed instance {keyed}</p>
    </section>
  {/key}
  <button onclick={() => (keyed += 1)}>bump key</button>

  <!-- await block -->
  <section class="await">
    {#await promise}
      <p>loading…</p>
    {:then value}
      <p>resolved: {value}</p>
    {:catch error}
      <p>failed: {error.message}</p>
    {/await}
  </section>
  <button onclick={() => (promise = loadData())}>reload await</button>

  <!-- snippet + render tag, so `render` dev stack entries appear -->
  {#snippet badge(text)}
    <span class="badge">{text}</span>
  {/snippet}

  <Card title="With snippet children">
    {@render badge('rendered via snippet')}
    <p>Card body content</p>
  </Card>
</main>

<style>
  main {
    font-family: system-ui, sans-serif;
    max-width: 45rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  section {
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 0.75rem;
    margin: 0.75rem 0;
  }
  .badge {
    background: #ff3e00;
    color: white;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.8rem;
  }
  button {
    margin-right: 0.5rem;
  }
</style>
