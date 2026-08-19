/**
 * Reactive state access.
 *
 * Svelte 5 keeps component state in module-scoped signals inside
 * `svelte/internal/client`, so there is no way to enumerate a component's
 * `$state`/`$derived` from outside that module instance. `component_context`
 * and `dev_stack` are module-level `let` bindings, and no global devtools hook
 * exists (upstream issue #11389 tracks adding one).
 *
 * Consequently:
 *   - Tier 1 (extension only) reports the DOM-observable facts and explains
 *     that live state needs the Vite plugin.
 *   - Tier 2 reads through `window.__SVELTE_DEVTOOLS_HOOK__`, installed by our
 *     Vite plugin, which captures `push`/`pop` and signal labels.
 *
 * Writing state is comparatively easy once a reference exists: `$state` values
 * are proxies (`proxy.js`), so ordinary assignment triggers reactivity. No
 * `$inject_state` equivalent is required.
 */

const HOOK = '__SVELTE_DEVTOOLS_HOOK__';

export function hasHook() {
  return typeof window !== 'undefined' && !!window[HOOK];
}

function hook() {
  return window[HOOK];
}

/**
 * Reads the state associated with a tree node.
 *
 * @returns {{ tier: 1 | 2, values: object, note?: string }}
 */
export function readState(node) {
  if (!node) return { tier: 1, values: {} };

  if (hasHook()) {
    const record = hook().stateFor?.(node);
    if (record) return { tier: 2, values: record };
  }

  // Tier 1 fallback: surface what the metadata alone can tell us.
  return {
    tier: 1,
    values: {
      source: node.loc ? `${node.loc.file}:${node.loc.line}:${node.loc.column}` : undefined,
      blockType: node.type
    },
    note: 'Live $state requires the svelte5-devtools Vite plugin. Add it to see props, $state and $derived values.'
  };
}

/**
 * Writes a value into reactive state.
 *
 * @param {object} node
 * @param {string[]} path property path within the component's state
 * @param {unknown} value already-parsed value
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeState(node, path, value) {
  if (!hasHook()) {
    return { ok: false, error: 'Editing state requires the svelte5-devtools Vite plugin.' };
  }
  try {
    const target = hook().targetFor?.(node, path.slice(0, -1));
    if (!target || typeof target !== 'object') {
      return { ok: false, error: 'Target is not writable.' };
    }
    // `$state` values are proxies, so a plain assignment is enough to notify
    // subscribers; no internal `set()` call is needed.
    target[path[path.length - 1]] = value;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
