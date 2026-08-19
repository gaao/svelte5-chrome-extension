<script>
  /**
   * Recursive value viewer for props/state/attributes.
   *
   * Renders the tagged placeholders produced by `src/agent/serialize.js`
   * (`{ __is: 'function' | 'circular' | … }`) and allows editing primitives
   * when the agent reports a writable target.
   */
  import PropertyList from './PropertyList.svelte';
  import Editable from './Editable.svelte';

  let { entries, path = [], editable = false, onedit } = $props();

  /** Splits a serialized value into a display kind plus its children. */
  function describe(value) {
    if (value === null) return { kind: 'null', display: 'null' };

    if (typeof value === 'object' && !Array.isArray(value) && typeof value.__is === 'string') {
      switch (value.__is) {
        case 'undefined':
          return { kind: 'undefined', display: 'undefined' };
        case 'nan':
          return { kind: 'number', display: 'NaN' };
        case 'bigint':
          return { kind: 'number', display: `${value.value}n` };
        case 'symbol':
          return { kind: 'symbol', display: `Symbol(${value.name})` };
        case 'function':
          return {
            kind: 'function',
            display: `ƒ ${value.name}()`,
            source: value.source
          };
        case 'circular':
          return { kind: 'circular', display: `[circular → ${value.path}]` };
        case 'truncated':
          return { kind: 'dim', display: value.preview ?? '…' };
        case 'node':
          return { kind: 'node', display: value.name };
        case 'date':
          return { kind: 'string', display: value.value };
        case 'regexp':
          return { kind: 'string', display: value.value };
        case 'error':
          return { kind: 'error', display: `${value.name}: ${value.message}` };
        case 'getter':
          return { kind: 'dim', display: '(getter)' };
        case 'map':
          return {
            kind: 'object',
            display: `Map(${value.size})`,
            children: value.entries.map(([k, v], i) => ({
              key: typeof k === 'object' ? `#${i}` : String(k),
              value: v
            }))
          };
        case 'set':
          return {
            kind: 'object',
            display: `Set(${value.size})`,
            children: value.items.map((v, i) => ({ key: String(i), value: v }))
          };
      }
    }

    if (Array.isArray(value)) {
      return {
        kind: 'object',
        display: `Array(${value.length})`,
        children: value.map((v, i) => ({ key: String(i), value: v }))
      };
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      return {
        kind: 'object',
        display: keys.length ? `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}` : '{}',
        children: keys.map((k) => ({ key: k, value: value[k] }))
      };
    }

    if (typeof value === 'string') return { kind: 'string', display: `"${value}"`, primitive: true };
    if (typeof value === 'number') return { kind: 'number', display: String(value), primitive: true };
    if (typeof value === 'boolean') return { kind: 'boolean', display: String(value), primitive: true };

    return { kind: 'dim', display: String(value) };
  }

  let expanded = $state(new Set());

  function toggle(key) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }
</script>

<ul>
  {#each entries as entry (entry.key)}
    {@const info = describe(entry.value)}
    {@const rowKey = [...path, entry.key].join('.')}
    {@const open = expanded.has(rowKey)}
    <li>
      <div class="row">
        {#if info.children?.length || info.source}
          <button class="twisty" onclick={() => toggle(rowKey)} aria-expanded={open}>
            {open ? '▼' : '▶'}
          </button>
        {:else}
          <span class="twisty" aria-hidden="true"></span>
        {/if}

        <span class="key">{entry.key}</span><span class="punct">:</span>

        {#if editable && info.primitive}
          <Editable
            value={entry.value}
            onsubmit={(next) => onedit?.([...path, entry.key], next)}
          />
        {:else}
          <span class={info.kind}>{info.display}</span>
        {/if}
      </div>

      {#if open}
        {#if info.source}
          <pre>{info.source}</pre>
        {/if}
        {#if info.children?.length}
          <PropertyList
            entries={info.children}
            path={[...path, entry.key]}
            {editable}
            {onedit}
          />
        {/if}
      {/if}
    </li>
  {/each}
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding-left: 12px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 3px;
    font: 11px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: nowrap;
  }
  .twisty {
    width: 11px;
    flex: none;
    background: none;
    border: 0;
    padding: 0;
    color: var(--dim);
    font-size: 8px;
    cursor: pointer;
    text-align: left;
  }
  .key {
    color: var(--attr);
  }
  .punct {
    color: var(--dim);
  }
  .string {
    color: var(--string);
  }
  .number,
  .boolean {
    color: var(--number);
  }
  .null,
  .undefined,
  .dim,
  .symbol {
    color: var(--dim);
  }
  .function {
    color: var(--component);
    font-style: italic;
  }
  .circular {
    color: var(--dim);
    font-style: italic;
  }
  .error {
    color: var(--error);
  }
  .node {
    color: var(--tag);
  }
  .object {
    color: var(--fg);
  }
  pre {
    margin: 2px 0 4px 24px;
    padding: 4px 6px;
    background: var(--hover);
    border-radius: 3px;
    font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: pre-wrap;
    max-height: 140px;
    overflow: auto;
    color: var(--dim);
  }
</style>
