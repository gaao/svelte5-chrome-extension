/**
 * Vite plugin that unlocks live state inspection (Tier 2).
 *
 * Svelte 5 keeps component state in signals held by module-scoped variables
 * inside `svelte/internal/client`. `component_context` and `dev_stack` are
 * `let` bindings, not globals, so a browser extension has no way to reach them
 * (upstream issue sveltejs/svelte#11389 tracks exposing them officially).
 *
 * The only reliable way in is to *be* an importer of that module. This plugin
 * therefore aliases `svelte/internal/client` to a wrapper that re-exports
 * everything and intercepts a few functions, then publishes what it captures on
 * `window.__SVELTE_DEVTOOLS_HOOK__` for the extension to read.
 *
 * Enabled only for `vite serve`, since it depends on dev-mode metadata.
 */

const WRAPPER_ID = '\0svelte5-devtools/client';
const HOOK_ID = '\0svelte5-devtools/hook';
const TARGET = 'svelte/internal/client';
/**
 * Suffix that marks "resolve this to the genuine runtime, not the wrapper".
 * Needed because `this.resolve` re-enters our own `resolveId`, which would
 * otherwise hand the wrapper back to itself.
 */
const BYPASS = '?svelte5-devtools-original';

/**
 * @param {{ enabled?: boolean }} [options]
 * @returns {import('vite').Plugin}
 */
export function svelteDevtools(options = {}) {
  let enabled = options.enabled ?? true;

  return {
    name: 'svelte5-devtools',
    // Must run before vite-plugin-svelte so the alias applies to the code it
    // generates for each component.
    enforce: 'pre',
    apply: 'serve',

    config(_, { command }) {
      if (command !== 'serve') enabled = false;
    },

    resolveId(id, importer) {
      if (!enabled) return null;
      if (id === HOOK_ID || id === WRAPPER_ID) return id;
      // The wrapper asks for the genuine runtime using the bypass suffix.
      if (id === TARGET + BYPASS) {
        return this.resolve(TARGET, importer, { skipSelf: true });
      }
      if (id === TARGET) return WRAPPER_ID;
      return null;
    },

    load(id) {
      if (id === HOOK_ID) return hook();
      // Virtual modules cannot use `/@id/` specifiers in their own imports, so
      // the wrapper imports the bare ids and lets `resolveId` above sort them
      // out.
      if (id === WRAPPER_ID) return wrapper();
      return null;
    },

    transformIndexHtml() {
      if (!enabled) return;
      // Load the hook before app code so `push` interception is in place for
      // the very first component.
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: `import ${JSON.stringify('/@id/' + HOOK_ID)};`,
          injectTo: 'head-prepend'
        }
      ];
    },

    configureServer(server) {
      if (!enabled) return;

      // Vite's built-in `/__open-in-editor` ignores a chosen editor (it never
      // passes `specifiedEditor` to launch-editor). This endpoint accepts
      // `?file=...&editor=...` so the extension's IDE picker works.
      server.middlewares.use('/__svelte-devtools/open', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const file = url.searchParams.get('file');
          const editor = url.searchParams.get('editor') || undefined;

          if (!file) {
            res.statusCode = 400;
            res.end('missing "file"');
            return;
          }

          const launch = (await import('launch-editor')).default;
          launch(file, editor, (fileName, errorMsg) => {
            console.warn(
              `[svelte5-devtools] could not open ${fileName}${editor ? ` with ${editor}` : ''}: ${errorMsg}`
            );
          });
          res.end();
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error?.message || error));
        }
      });
    }
  };
}

/**
 * Re-exports the real runtime, replacing the handful of functions that carry
 * the information we need. Everything else passes through untouched, so this
 * stays resilient across Svelte versions.
 */
function wrapper() {
  const real = JSON.stringify(TARGET + BYPASS);
  const hookId = JSON.stringify(HOOK_ID);
  return `
export * from ${real};
import { push as real_push, pop as real_pop, tag as real_tag, tag_proxy as real_tag_proxy } from ${real};
import { hook } from ${hookId};

/**
 * \`push\` runs at the start of every component. In DEV its third argument is
 * the component function, which carries the FILENAME symbol, so this is where a
 * component instance can be registered and correlated with the tree.
 */
export function push(props, runes, fn) {
  const result = real_push(props, runes, fn);
  try {
    hook.pushComponent(props, fn);
  } catch {}
  return result;
}

export function pop(component) {
  try {
    hook.popComponent(component);
  } catch {}
  return real_pop(component);
}

/** \`tag\` attaches a debug label to a signal in DEV; use it to name state. */
export function tag(source, label) {
  try {
    hook.tagSignal(source, label);
  } catch {}
  return real_tag(source, label);
}

export function tag_proxy(value, label) {
  try {
    hook.tagSignal(value, label);
  } catch {}
  return real_tag_proxy(value, label);
}
`;
}

/**
 * The hook itself. Keeps a stack of component instances during initialization
 * and records the props object plus labelled signals for each, then exposes a
 * lookup keyed by source location so the extension can match tree nodes.
 */
function hook() {
  return `
/**
 * Svelte tags component functions with their source path under
 * \`FILENAME = Symbol('filename')\` (src/constants.js). That symbol is unique
 * rather than registered, so \`Symbol.for\` cannot reach it — it has to be found
 * by description on the component function itself.
 */
function fileOf(fn) {
  if (typeof fn !== 'function') return null;
  for (const symbol of Object.getOwnPropertySymbols(fn)) {
    if (symbol.description === 'filename') {
      const value = fn[symbol];
      if (typeof value === 'string') return value;
    }
  }
  return fn.name || null;
}

/** Records keyed by source file, each holding that component's instances. */
const registry = new Map();
/** Components currently initialising, innermost last. */
const stack = [];

export const hook = {
  pushComponent(props, fn) {
    const file = fileOf(fn);
    const record = { file, props, signals: new Map(), children: [] };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(record);
    stack.push(record);

    if (file) {
      let list = registry.get(file);
      if (!list) registry.set(file, (list = []));
      list.push(record);
    }
  },

  popComponent() {
    stack.pop();
  },

  /**
   * \`tag\` runs during component initialisation, so the innermost entry on the
   * stack owns the signal being labelled.
   */
  tagSignal(signal, label) {
    const current = stack[stack.length - 1];
    if (current && label) current.signals.set(label, signal);
  }
};

/** Normalises paths so the extension can match on a file suffix. */
function matches(recordFile, wanted) {
  if (!recordFile || !wanted) return false;
  const a = recordFile.replace(/\\\\/g, '/');
  const b = wanted.replace(/\\\\/g, '/');
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

/**
 * Surface consumed by the extension agent. Deliberately small, so the protocol
 * between plugin and extension is easy to keep stable.
 */
window.__SVELTE_DEVTOOLS_HOOK__ = {
  version: 1,

  /** All files the hook knows about; used for diagnostics. */
  files() {
    return [...registry.keys()];
  },

  /**
   * Resolves state for a tree node. Nodes are matched by the source file of the
   * component they belong to; \`instanceIndex\` disambiguates when a component
   * has several instances.
   */
  stateFor(node) {
    const wanted = node?.loc?.file ?? node?.file;
    if (!wanted) return null;

    let list = registry.get(wanted);
    if (!list) {
      for (const [file, candidates] of registry) {
        if (matches(file, wanted)) {
          list = candidates;
          break;
        }
      }
    }
    if (!list?.length) return null;

    const record = list[node.instanceIndex ?? 0] ?? list[0];
    const out = {};

    // Props are the component's inputs. Reading them goes through the props
    // proxy, so values are current rather than initial.
    try {
      for (const key of Object.keys(record.props ?? {})) {
        if (key.startsWith('$$')) continue;
        try {
          out[key] = record.props[key];
        } catch {}
      }
    } catch {}

    // Then labelled signals: $state and $derived.
    for (const [label, signal] of record.signals) {
      try {
        out[label] = signal && typeof signal === 'object' && 'v' in signal ? signal.v : signal;
      } catch {}
    }

    return out;
  },

  /** Resolves the object a write should target. */
  targetFor(node, path) {
    const state = this.stateFor(node);
    if (!state) return null;
    let target = state;
    for (const key of path) {
      target = target?.[key];
      if (target == null) return null;
    }
    return target;
  }
};
`;
}

export default svelteDevtools;
