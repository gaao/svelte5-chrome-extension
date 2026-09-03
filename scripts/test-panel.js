/**
 * Renders the panel UI in jsdom against a synthetic tree, so the Svelte
 * components are verified to mount and respond to interaction.
 *
 * The extension itself cannot be loaded in this environment (no Chrome
 * extension host available), so this covers the panel's rendering and
 * interaction logic while leaving the browser-integration path to manual
 * verification documented in the README.
 *
 * Run: node --conditions=browser scripts/test-panel.js
 */
import { createDom, loadComponent, bootPlayground, root } from './harness.js';
import { buildTree } from '../src/agent/tree.js';
import { serializeNode } from '../src/agent/serialize.js';
import { join } from 'node:path';

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

// Build a realistic node set from the playground, then hand it to the panel.
const source = await bootPlayground();
const tree = buildTree({ root: source.document });
const serialized = [...tree.byId.values()].map(serializeNode);
const rootId = tree.root.id;

// A fresh DOM for the panel itself, with the chrome APIs it touches stubbed.
const dom = createDom();
const sent = [];

dom.window.chrome = {
  devtools: {
    inspectedWindow: {
      tabId: 1,
      eval: (expression, cb) => cb?.('http://localhost:5273', null)
    },
    panels: { themeName: 'dark' }
  },
  runtime: {
    connect: () => ({
      name: '1',
      postMessage: (m) => sent.push(m),
      onMessage: { addListener: (fn) => (dom.window.__receive = fn) },
      onDisconnect: { addListener: () => {} }
    }),
    getURL: (p) => `chrome-extension://test${p}`
  }
};

// The panel modules read `chrome` and `window` from globals. This DOM replaces
// the playground's, so every DOM global has to be repointed at it, or Svelte
// will mount into the wrong document.
for (const key of [
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'HTMLMediaElement',
  'HTMLAnchorElement',
  'Text',
  'Comment',
  'DocumentFragment',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle'
]) {
  if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
}
globalThis.chrome = dom.window.chrome;

// Panel modules use runes, so they are compiled through the harness rather than
// imported directly. `App.svelte` is mounted without `main.js`, whose CSS import
// is irrelevant here.
const runtimeModule = await loadComponent(join(root, 'src/panel/lib/runtime.svelte.js'));
const app = runtimeModule.app;
const svelte = await import('svelte');
const App = (await loadComponent(join(root, 'src/panel/App.svelte'))).default;
console.log('=== panel boot ===');
check('panel connected via port', sent.some((m) => m.type === 'bypass::ext/init'));

// Feed the panel the same messages the agent would send.
const receive = dom.window.__receive;
check('panel registered a message listener', typeof receive === 'function');

receive({
  source: 'svelte-devtools',
  type: 'bypass::ext/detected',
  payload: { major: 5, versions: ['5'], hasMeta: true, tier: 2 }
});
receive({
  source: 'svelte-devtools',
  type: 'bridge::agent/tree',
  payload: { root: rootId, nodes: serialized, stats: tree.stats }
});

svelte.mount(App, { target: dom.window.document.body });
svelte.flushSync();

const doc = dom.window.document;
const text = doc.body.textContent ?? '';

console.log('\n=== rendering ===');
check('status reflects the detected version', text.includes('Svelte 5'), text.slice(0, 80));
check('tier 2 badge shown', text.includes('Tier 2'));

const editorSelect = doc.querySelector('.editor-picker select');
check('IDE picker is present', !!editorSelect);
if (editorSelect) {
  const labels = [...editorSelect.options].map((o) => o.textContent);
  check('IDE picker lists mainstream editors', labels.some((l) => l.includes('VS Code') || l.includes('Visual Studio')));
  check('IDE picker includes Trae', labels.some((l) => l.includes('Trae')));
}
check('root component rendered in the tree', text.includes('App'));
check('child components rendered', text.includes('Counter') && text.includes('TodoList'));
check('block types rendered', text.includes('each') || text.includes('if'));
check('element rows rendered', text.includes('main') || text.includes('section'));

const rows = doc.querySelectorAll('[data-node-id]');
check('tree rendered many rows', rows.length > 20, `${rows.length} rows`);

console.log('\n=== interaction ===');
// Selecting a row must notify the agent and populate the details pane.
const counterRow = [...rows].find((r) => r.textContent?.includes('Counter'));
check('found a Counter row', !!counterRow);

if (counterRow) {
  counterRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  svelte.flushSync();
  check('selection sent to the agent', sent.some((m) => m.type === 'bridge::ext/select'));
  check('selection recorded in the store', !!app.selectedId);

  // Simulate the agent replying with state.
  receive({
    source: 'svelte-devtools',
    type: 'bridge::agent/selected',
    payload: {
      detail: {
        id: app.selectedId,
        type: 'component',
        tagName: 'Counter',
        loc: { file: 'playground/src/Counter.svelte', line: 1, column: 0 },
        tier: 2,
        state: { label: 'First', count: 3, doubled: 6 }
      }
    }
  });
  svelte.flushSync();

  const detailText = doc.body.textContent ?? '';
  check('details pane shows state section', detailText.includes('State'));
  check('state values rendered', detailText.includes('label') && detailText.includes('count'));
  check('derived value rendered', detailText.includes('doubled'));
}

// Search must find nodes and report a count.
const searchInput = doc.querySelector('input[placeholder="Search tree"]');
check('search input present', !!searchInput);
if (searchInput) {
  searchInput.value = 'TodoRow';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  svelte.flushSync();
  check('search found matches', app.matches.length > 0, `${app.matches.length} matches`);
  check('match counter rendered', (doc.body.textContent ?? '').includes(`/ ${app.matches.length}`));
}

// Filtering a type out must remove those rows.
const beforeRows = doc.querySelectorAll('[data-node-id]').length;
app.visibility.element = false;
svelte.flushSync();
const afterRows = doc.querySelectorAll('[data-node-id]').length;
check('hiding element rows shrinks the tree', afterRows < beforeRows, `${beforeRows} -> ${afterRows}`);
app.visibility.element = true;
svelte.flushSync();

// Inspect toggle must message the agent.
const inspectButton = doc.querySelector('button[aria-label="Inspect element"]');
check('inspect button present', !!inspectButton);
if (inspectButton) {
  inspectButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  svelte.flushSync();
  check('inspect mode sent to the agent', sent.some((m) => m.type === 'bridge::ext/inspect'));
}

console.log('\n=== degraded states ===');
receive({
  source: 'svelte-devtools',
  type: 'bypass::ext/detected',
  payload: { major: 5, versions: ['5'], hasMeta: false, tier: 1 }
});
svelte.flushSync();
check(
  'explains missing dev metadata rather than showing an empty tree',
  (doc.body.textContent ?? '').includes('dev metadata'),
);
check(
  'mentions the 5.35.1 requirement',
  (doc.body.textContent ?? '').includes('5.35.1')
);

receive({
  source: 'svelte-devtools',
  type: 'bypass::ext/detected',
  payload: { major: null, versions: [], hasMeta: false, tier: 1 }
});
svelte.flushSync();
check(
  'reports when no Svelte app is present',
  (doc.body.textContent ?? '').includes('No Svelte application detected')
);

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join(', ')}`}`
);
process.exit(failures.length === 0 ? 0 : 1);
