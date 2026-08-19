<script>
  /**
   * Inline editor for a primitive value.
   *
   * Input is parsed the way a JS literal would be, so `null`, `true`, numbers
   * and quoted strings all round-trip. Unquoted text is treated as a string.
   */
  let { value, onsubmit } = $props();

  let editing = $state(false);
  let draft = $state('');
  /** @type {HTMLInputElement | undefined} */
  let input = $state();

  const display = $derived(typeof value === 'string' ? `"${value}"` : String(value));

  function begin() {
    draft = typeof value === 'string' ? value : String(value);
    editing = true;
  }

  function parse(text) {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === 'undefined') return undefined;
    if (trimmed === 'null') return null;
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
    // Strip matching quotes if the user typed them explicitly.
    if (/^(["']).*\1$/s.test(trimmed)) return trimmed.slice(1, -1);
    return text;
  }

  function commit() {
    if (!editing) return;
    editing = false;
    const next = parse(draft);
    if (next !== value) onsubmit?.(next);
  }

  function cancel() {
    editing = false;
  }

  $effect(() => {
    if (editing && input) {
      input.focus();
      input.select();
    }
  });
</script>

{#if editing}
  <input
    bind:this={input}
    bind:value={draft}
    onblur={commit}
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      e.stopPropagation();
    }}
  />
{:else}
  <button class="value" onclick={begin} title="Click to edit">{display}</button>
{/if}

<style>
  button.value {
    background: none;
    border: 0;
    padding: 0 2px;
    font: inherit;
    color: var(--string);
    cursor: text;
    border-bottom: 1px dotted var(--dim);
  }
  button.value:hover {
    background: var(--hover);
  }
  input {
    font: inherit;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--accent);
    border-radius: 2px;
    padding: 0 2px;
    min-width: 60px;
    max-width: 220px;
  }
</style>
