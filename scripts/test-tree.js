/**
 * Exercises the Tier 1 tree builder against the playground app running on the
 * real Svelte client runtime, and asserts the structural properties the panel
 * UI depends on.
 *
 * Run: node --conditions=browser scripts/test-tree.js
 */
import { bootPlayground } from './harness.js';
import { buildTree, formatTree } from '../src/agent/tree.js';

const { document, window } = await bootPlayground();

const result = buildTree({ root: document });

console.log('=== tree ===');
console.log(formatTree(result.root));
console.log('\n=== stats ===');
console.log(result.stats, 'total nodes:', result.byId.size);

// ---- assertions ---------------------------------------------------------

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

const nodes = [...result.byId.values()];
const byType = (type) => nodes.filter((n) => n.type === type);
const named = (tag) => nodes.filter((n) => n.tagName === tag);

console.log('\n=== assertions ===');

check('a root node exists', !!result.root);
check('version global present', [...(window.__svelte?.v ?? [])].includes('5'));

// Every node except the root must be reachable from the root exactly once.
const seen = new Set();
let cycles = false;
(function walk(node, ancestors) {
  if (ancestors.has(node)) {
    cycles = true;
    return;
  }
  seen.add(node);
  const next = new Set(ancestors).add(node);
  for (const c of node.children) walk(c, next);
})(result.root, new Set());

check('no cycles in tree', !cycles);
check(
  'every node reachable from root',
  seen.size === result.byId.size,
  `reachable ${seen.size} of ${result.byId.size}`
);
check(
  'parent pointers agree with children arrays',
  nodes.every((n) => n === result.root || n.parent?.children.includes(n))
);

// Component detection
check('two Counter components', named('Counter').length === 2, `found ${named('Counter').length}`);
check('one TodoList component', named('TodoList').length === 1);
check('one Card component', named('Card').length === 1);
check(
  'three TodoRow components (one per each-iteration)',
  named('TodoRow').length === 3,
  `found ${named('TodoRow').length}`
);

// Recursive component: Nested renders itself to depth 3 => 1 + 3 instances
check(
  'recursive Nested renders 4 component nodes',
  named('Nested').length + named('Self').length === 4,
  `Nested=${named('Nested').length} Self=${named('Self').length}`
);

// Block types
check('each block present', byType('each').length >= 1);
check('if blocks present', byType('if').length >= 1);
check('key block present', byType('key').length === 1);
check('render (snippet) blocks present', byType('render').length >= 1);

// Iteration synthesis: the todo each-block should have 3 iterations
const eachNodes = byType('each');
const todoEach = eachNodes.find((n) => n.file?.includes('TodoList'));
check('todo each block found', !!todoEach);
if (todoEach) {
  const iterations = todoEach.children.filter((c) => c.type === 'iteration');
  check(
    'todo each has 3 synthesized iterations',
    iterations.length === 3,
    `found ${iterations.length}`
  );
  check(
    'each iteration contains a TodoRow component',
    iterations.every((it) => it.children.some((c) => c.tagName === 'TodoRow')),
    iterations.map((it) => it.children.map((c) => c.tagName).join('+')).join(' | ')
  );
}

// Elements keep their DOM references so highlighting/selection can work.
const elements = byType('element');
check('element nodes carry DOM references', elements.every((n) => !!n.element));
check(
  'element nodes carry source locations',
  elements.every((n) => n.loc && typeof n.loc.line === 'number')
);

// Snippet content should be placed under the render tag, not lexically.
const badge = elements.find((n) => n.element?.classList?.contains('badge'));
check('snippet-rendered badge element found', !!badge);
if (badge) {
  const chain = [];
  for (let p = badge.parent; p; p = p.parent) chain.push(`${p.tagName}(${p.type})`);
  check(
    'badge is nested under a render tag inside Card',
    chain.some((c) => c.includes('render')) && chain.some((c) => c.startsWith('Card')),
    chain.join(' < ')
  );
}

// --- structural placement: groups must sit at their DOM position, not be
// flattened onto the component root. This guards the pass-2/3 anchor logic.
const main = elements.find((n) => n.tagName === 'main');
check('main element is the first child of the root', result.root.children[0] === main);

const counters = named('Counter');
check(
  'Counter components nest inside a <section>, not the root',
  counters.every((c) => c.parent?.tagName === 'section'),
  counters.map((c) => c.parent?.tagName).join(', ')
);

const todoList = named('TodoList')[0];
check('TodoList nests inside a <section>', todoList?.parent?.tagName === 'section');

if (todoEach) {
  check('each block nests inside the <ul>', todoEach.parent?.tagName === 'ul');
}

const cardNode = named('Card')[0];
check('Card nests inside <main>', cardNode?.parent === main);

// Document order must be preserved among siblings.
const mainChildLines = main
  ? main.children.filter((c) => c.type === 'element' && c.loc).map((c) => c.loc.line)
  : [];
check(
  'sibling elements are in document order',
  mainChildLines.every((line, i) => i === 0 || mainChildLines[i - 1] <= line),
  mainChildLines.join(',')
);

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join(', ')}`}`
);
process.exit(failures.length === 0 ? 0 : 1);
