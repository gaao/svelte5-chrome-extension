/**
 * Value serialization for transport between the page and the devtools panel.
 *
 * Messages cross a `postMessage` boundary, so every value has to survive
 * structured cloning. Functions, symbols, DOM nodes, Svelte state proxies and
 * cyclic references all need explicit handling.
 *
 * Placeholders use an `__is` tag so the panel can render them distinctly.
 * Unlike the Svelte 4 devtools, repeated objects become explicit back-references
 * (`{ __is: 'circular', path }`) instead of silently collapsing to `{}`.
 */

const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY = 100;
const MAX_STRING = 10_000;

/**
 * @param {unknown} value
 * @param {object} [options]
 * @param {number} [options.depth] maximum nesting depth
 * @returns {unknown} a structured-clone-safe representation
 */
export function serialize(value, { depth = MAX_DEPTH } = {}) {
  return walk(value, depth, new Map(), '$');
}

function walk(value, budget, seen, path) {
  if (value === null) return null;

  const type = typeof value;

  if (type === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (type === 'number' || type === 'boolean') {
    return Number.isNaN(value) ? { __is: 'nan' } : value;
  }
  if (type === 'undefined') return { __is: 'undefined' };
  if (type === 'bigint') return { __is: 'bigint', value: value.toString() };
  if (type === 'symbol') return { __is: 'symbol', name: value.description ?? '' };
  if (type === 'function') {
    return {
      __is: 'function',
      name: value.name || '(anonymous)',
      source: truncateSource(value)
    };
  }

  // Objects from here on.
  if (seen.has(value)) return { __is: 'circular', path: seen.get(value) };

  if (isNode(value)) {
    return {
      __is: 'node',
      name: nodeName(value)
    };
  }

  if (value instanceof Date) return { __is: 'date', value: value.toISOString() };
  if (value instanceof RegExp) return { __is: 'regexp', value: String(value) };
  if (value instanceof Error) {
    return { __is: 'error', name: value.name, message: value.message };
  }

  if (budget <= 0) {
    return { __is: 'truncated', preview: preview(value) };
  }

  seen.set(value, path);

  try {
    if (value instanceof Map) {
      const entries = [];
      let i = 0;
      for (const [k, v] of value) {
        if (i >= MAX_KEYS) break;
        entries.push([walk(k, budget - 1, seen, `${path}.@${i}k`), walk(v, budget - 1, seen, `${path}.@${i}v`)]);
        i++;
      }
      return { __is: 'map', size: value.size, entries };
    }

    if (value instanceof Set) {
      const items = [];
      let i = 0;
      for (const v of value) {
        if (i >= MAX_KEYS) break;
        items.push(walk(v, budget - 1, seen, `${path}.@${i}`));
        i++;
      }
      return { __is: 'set', size: value.size, items };
    }

    if (Array.isArray(value)) {
      const out = value
        .slice(0, MAX_ARRAY)
        .map((v, i) => walk(v, budget - 1, seen, `${path}[${i}]`));
      if (value.length > MAX_ARRAY) {
        out.push({ __is: 'truncated', preview: `… ${value.length - MAX_ARRAY} more items` });
      }
      return out;
    }

    // Plain-ish object.
    const out = {};
    const keys = Reflect.ownKeys(value).filter((k) => typeof k === 'string');
    for (const key of keys.slice(0, MAX_KEYS)) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        continue;
      }
      // Reading a getter can throw or have side effects; report it instead.
      if (descriptor && !('value' in descriptor)) {
        out[key] = { __is: 'getter' };
        continue;
      }
      try {
        out[key] = walk(value[key], budget - 1, seen, `${path}.${key}`);
      } catch (error) {
        out[key] = { __is: 'error', name: 'ThrewOnRead', message: String(error) };
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function truncateSource(fn) {
  let source;
  try {
    source = fn.toString();
  } catch {
    return '(source unavailable)';
  }
  return source.length > 500 ? source.slice(0, 500) + '…' : source;
}

function isNode(value) {
  return typeof Node !== 'undefined' && value instanceof Node;
}

function nodeName(node) {
  if (node.nodeType === 1) {
    const el = /** @type {Element} */ (node);
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }
  return `#${node.nodeName.toLowerCase()}`;
}

function preview(value) {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const name = value?.constructor?.name;
  return name && name !== 'Object' ? name : 'Object';
}

/**
 * Serializes a tree node into the shape the panel consumes. DOM references and
 * metadata entry objects are dropped, since neither can cross postMessage.
 */
export function serializeNode(node) {
  const el = node.element;
  return {
    id: node.id,
    type: node.type,
    tagName: node.tagName,
    loc: node.loc ? { ...node.loc } : null,
    parent: node.parent?.id ?? null,
    children: node.children.map((c) => c.id),
    attributes: el ? attributesOf(el) : [],
    listeners: el ? listenersOf(el) : [],
    text: el ? directText(el) : ''
  };
}

function attributesOf(el) {
  return [...el.attributes]
    .filter((a) => a.name !== 'class' || a.value.trim() !== '')
    .map((a) => ({ key: a.name, value: a.value }));
}

/**
 * Svelte 5 stores delegated handlers in an object under a private symbol
 * (`event_symbol = Symbol('events')` in
 * `internal/client/dom/elements/events.js`), keyed by event name. That symbol
 * is not exported, so it is located by description on whichever element first
 * exposes it. Non-delegated handlers go through `addEventListener` and are not
 * enumerable from script at all, so they cannot be listed.
 */
function eventSymbolOf(el) {
  for (const key of Reflect.ownKeys(el)) {
    if (typeof key === 'symbol' && key.description === 'events') return key;
  }
  return null;
}

function listenersOf(el) {
  const symbol = eventSymbolOf(el);
  if (!symbol) return [];

  const map = el[symbol];
  if (!map || typeof map !== 'object') return [];

  const out = [];
  for (const [event, handler] of Object.entries(map)) {
    if (typeof handler === 'function') {
      out.push({ event, handler: truncateSource(handler) });
    }
  }
  return out;
}

/** Direct text content, excluding text inside child elements. */
function directText(el) {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === 3) text += child.nodeValue;
  }
  text = text.trim();
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}
