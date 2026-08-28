/**
 * Verifies that Tier 1 tree nodes correlate correctly with Tier 2 hook state:
 * a component node must resolve to its *own* instance, not just the first
 * instance of that component.
 *
 * Run: node --conditions=browser scripts/test-integration.js
 */
import { bootPlaygroundWithHook } from './harness-hook.js';
import { buildTree } from '../src/agent/tree.js';
import { readState, writeState } from '../src/agent/state.js';

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

const booted = await bootPlaygroundWithHook();
// The agent's state module reads `window.__SVELTE_DEVTOOLS_HOOK__`.
globalThis.window = booted.window;

const tree = buildTree({ root: booted.document });
const nodes = [...tree.byId.values()];

console.log('=== tier 2 wiring ===');
check('hook is visible to the agent state module', !!booted.window.__SVELTE_DEVTOOLS_HOOK__);

const counters = nodes.filter((n) => n.tagName === 'Counter');
check('two Counter nodes in the tree', counters.length === 2, `found ${counters.length}`);
check(
  'component nodes know their own source file',
  counters.every((c) => c.componentFile?.includes('Counter.svelte')),
  counters.map((c) => c.componentFile).join(' | ')
);
check(
  'component instances get distinct indices',
  new Set(counters.map((c) => c.instanceIndex)).size === counters.length,
  counters.map((c) => c.instanceIndex).join(',')
);

console.log('\n=== state resolution per instance ===');
const states = counters.map((c) => readState(c));
check('both Counter nodes resolve tier 2 state', states.every((s) => s.tier === 2), states.map((s) => s.tier).join(','));

for (const [i, state] of states.entries()) {
  console.log(`       Counter[${i}] label=${JSON.stringify(state.values.label)} start=${state.values.start} count=${state.values.count}`);
}

// The playground renders <Counter label="First" start={0} /> and
// <Counter label="Second" start={10} />, so the two instances must differ.
check(
  'instances resolve to different prop values',
  states[0]?.values.label === 'First' && states[1]?.values.label === 'Second',
  `${states[0]?.values.label} / ${states[1]?.values.label}`
);
check(
  'derived values are present and correct',
  states[1]?.values.doubled === states[1]?.values.count * 2,
  `count=${states[1]?.values.count} doubled=${states[1]?.values.doubled}`
);

console.log('\n=== writing state through a tree node ===');
const todoList = nodes.find((n) => n.tagName === 'TodoList');
check('TodoList node found', !!todoList);

if (todoList) {
  const before = readState(todoList);
  check('TodoList state resolves', before.tier === 2, JSON.stringify(Object.keys(before.values)));

  const result = writeState(todoList, ['items', '0', 'text'], 'written via tree node');
  check('write reports success', result.ok, result.error ?? '');
  booted.flushSync();

  const rendered = [...booted.document.querySelectorAll('span')].some(
    (s) => s.textContent === 'written via tree node'
  );
  check('DOM reflects the write', rendered);

  // The tree must pick the change up on rebuild.
  const rebuilt = buildTree({ root: booted.document });
  const texts = [...rebuilt.byId.values()]
    .filter((n) => n.type === 'element')
    .map((n) => n.element?.textContent);
  check('rebuilt tree sees the new text', texts.some((t) => t === 'written via tree node'));
}

console.log('\n=== tier 1 fallback ===');
// With no hook, state reads must degrade gracefully rather than throw.
const savedHook = booted.window.__SVELTE_DEVTOOLS_HOOK__;
delete booted.window.__SVELTE_DEVTOOLS_HOOK__;
const fallback = readState(counters[0]);
check('falls back to tier 1 without the hook', fallback.tier === 1);
check('tier 1 explains how to get live state', !!fallback.note && fallback.note.includes('Vite plugin'));
const denied = writeState(counters[0], ['count'], 5);
check('write is refused without the hook', !denied.ok && !!denied.error);
booted.window.__SVELTE_DEVTOOLS_HOOK__ = savedHook;

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join(', ')}`}`
);
process.exit(failures.length === 0 ? 0 : 1);
