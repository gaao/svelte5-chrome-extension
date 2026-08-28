/**
 * Exercises serialization, the mutation observer and highlight positioning
 * against the playground app.
 *
 * Run: node --conditions=browser scripts/test-agent.js
 */
import { bootPlayground } from './harness.js';
import { buildTree } from '../src/agent/tree.js';
import { serialize, serializeNode } from '../src/agent/serialize.js';
import { createObserver } from '../src/agent/observer.js';

const { document, window, svelte } = await bootPlayground();

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

console.log('=== serialize ===');

// Structured-clone safety is the whole point, so assert it directly.
const cloneable = (value) => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

const fn = function namedFn(a, b) {
  return a + b;
};
const cyclic = { name: 'root' };
cyclic.self = cyclic;
cyclic.list = [cyclic, 1];

const cases = {
  fn,
  cyclic,
  sym: Symbol('tag'),
  big: 10n ** 30n,
  nan: NaN,
  undef: undefined,
  date: new Date('2020-01-01T00:00:00Z'),
  re: /ab+c/gi,
  err: new Error('boom'),
  map: new Map([['a', 1]]),
  set: new Set([1, 2]),
  el: document.querySelector('main'),
  deep: { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } },
  getter: Object.defineProperty({}, 'boom', {
    get() {
      throw new Error('should not be read');
    },
    enumerable: true
  })
};

const out = serialize(cases);
check('serialized output is structured-cloneable', cloneable(out));
check('function becomes a tagged placeholder', out.fn.__is === 'function' && out.fn.name === 'namedFn');
check('cycle becomes a back-reference with a path', out.cyclic.self.__is === 'circular', JSON.stringify(out.cyclic.self));
check('cycle inside an array is also a back-reference', out.cyclic.list[0].__is === 'circular');
check('symbol tagged', out.sym.__is === 'symbol' && out.sym.name === 'tag');
check('bigint preserved as string', out.big.__is === 'bigint' && out.big.value === '1' + '0'.repeat(30));
check('NaN tagged', out.nan.__is === 'nan');
check('undefined tagged', out.undef.__is === 'undefined');
check('date tagged', out.date.__is === 'date');
check('regexp tagged', out.re.__is === 'regexp' && out.re.value === '/ab+c/gi');
check('error tagged', out.err.__is === 'error' && out.err.message === 'boom');
check('map tagged', out.map.__is === 'map' && out.map.size === 1);
check('set tagged', out.set.__is === 'set' && out.set.size === 2);
check('DOM node tagged, not serialized', out.el.__is === 'node' && out.el.name.startsWith('<main'));
check('depth is bounded', JSON.stringify(out.deep).includes('truncated'));
check('throwing getter is not invoked', out.getter.boom.__is === 'getter');

console.log('\n=== serializeNode ===');
const tree = buildTree({ root: document });
const nodes = [...tree.byId.values()].map(serializeNode);
check('all nodes serialize cloneably', cloneable(nodes));
check('node ids are unique', new Set(nodes.map((n) => n.id)).size === nodes.length);
check(
  'parent/child ids are internally consistent',
  nodes.every((n) => n.children.every((c) => nodes.some((m) => m.id === c)))
);

const button = nodes.find((n) => n.tagName === 'button');
check('element nodes expose attributes', Array.isArray(button?.attributes));
const withListener = nodes.find((n) => n.listeners?.length);
check(
  'delegated event handlers are discovered',
  !!withListener,
  withListener ? withListener.listeners.map((l) => l.event).join(',') : 'none found'
);

console.log('\n=== observer ===');
let rebuilds = 0;
const observer = createObserver(() => rebuilds++, { root: document });

// Mutating state should trigger exactly one coalesced rebuild.
const addButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'add todo');
check('found the add-todo button', !!addButton);
addButton?.click();
svelte.flushSync();

await new Promise((resolve) => setTimeout(resolve, 50));
check('observer fired after a state change', rebuilds >= 1, `fired ${rebuilds}x`);
check('observer coalesces many mutations into one callback', rebuilds === 1, `fired ${rebuilds}x`);

const after = buildTree({ root: document });
const rowsBefore = [...tree.byId.values()].filter((n) => n.tagName === 'TodoRow').length;
const rowsAfter = [...after.byId.values()].filter((n) => n.tagName === 'TodoRow').length;
check('tree reflects the added item', rowsAfter === rowsBefore + 1, `${rowsBefore} -> ${rowsAfter}`);

// Removing an item should shrink the tree again.
const removeButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '×');
removeButton?.click();
svelte.flushSync();
await new Promise((resolve) => setTimeout(resolve, 50));
const afterRemove = buildTree({ root: document });
const rowsRemoved = [...afterRemove.byId.values()].filter((n) => n.tagName === 'TodoRow').length;
check('tree reflects the removed item', rowsRemoved === rowsAfter - 1, `${rowsAfter} -> ${rowsRemoved}`);

observer.stop();
const before = rebuilds;
addButton?.click();
svelte.flushSync();
await new Promise((resolve) => setTimeout(resolve, 50));
check('stopped observer no longer fires', rebuilds === before);

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join(', ')}`}`
);
process.exit(failures.length === 0 ? 0 : 1);
