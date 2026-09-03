/**
 * Verifies the Tier 2 plugin.
 *
 * Split into two parts, because jsdom cannot execute ES modules at all
 * (`<script type="module">` is silently ignored), so a browser-style
 * integration test is impossible here:
 *
 *   1. Plugin wiring — start a real Vite dev server and assert that the module
 *      graph is rewritten correctly: components import the wrapper, the wrapper
 *      resolves to the genuine runtime without recursion, and the hook is
 *      injected before app code.
 *   2. Hook behaviour — run the generated hook and wrapper code in Node against
 *      the real Svelte runtime, mount a component, and assert that props and
 *      reactive state are actually captured.
 *
 * Run: node --conditions=browser scripts/test-plugin.js
 */
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { svelteDevtools } from '../packages/vite-plugin/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

// ---- part 1: plugin wiring ---------------------------------------------

const server = await createServer({
  root: resolve(root, 'playground'),
  configFile: false,
  logLevel: 'error',
  plugins: [svelteDevtools(), svelte()],
  server: { port: 5399, strictPort: true }
});
await server.listen();

const base = 'http://localhost:5399';
const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, text: await res.text() };
};

console.log('=== part 1: module graph rewriting ===');

const html = await get('/');
check('index.html served', html.status === 200);
check(
  'hook is injected into the page head',
  html.text.includes('svelte5-devtools/hook'),
  html.text.slice(0, 120)
);
// The hook must come before the app entry, or the first component's `push`
// happens before interception is installed.
const hookAt = html.text.indexOf('svelte5-devtools/hook');
const mainAt = html.text.indexOf('/src/main.js');
check('hook is injected before the app entry', hookAt !== -1 && hookAt < mainAt, `${hookAt} < ${mainAt}`);

const component = await get('/src/Counter.svelte');
check('component served', component.status === 200);
check(
  'component imports the devtools wrapper instead of the runtime',
  component.text.includes('svelte5-devtools/client'),
  component.text.split('\n').find((l) => l.includes('internal/client')) ?? ''
);

const wrapperUrl = '/@id/__x00__svelte5-devtools/client';
const wrapper = await get(wrapperUrl);
check('wrapper module served', wrapper.status === 200);
check('wrapper is not an error page', !wrapper.text.includes('Internal Server Error'));
check(
  'wrapper re-exports the genuine runtime (no self-recursion)',
  wrapper.text.includes('svelte_internal_client') || wrapper.text.includes('internal/client.js'),
  wrapper.text.split('\n')[1] ?? ''
);
check('wrapper intercepts push', /export function push\(/.test(wrapper.text));
check('wrapper intercepts pop', /export function pop\(/.test(wrapper.text));
check('wrapper intercepts tag', /export function tag\(/.test(wrapper.text));

const hookModule = await get('/@id/__x00__svelte5-devtools/hook');
check('hook module served', hookModule.status === 200);
check('hook installs the window global', hookModule.text.includes('__SVELTE_DEVTOOLS_HOOK__'));

// IDE picker endpoint. A missing file should 400; a well-formed request should
// be accepted (the editor may not exist in CI, so we don't assert it opens).
const noFile = await get('/__svelte-devtools/open');
check('editor endpoint rejects a request without file', noFile.status === 400, `got ${noFile.status}`);
// Use an editor name guaranteed not to exist so running the test never actually
// opens a window; the point is to verify the route accepts file + editor.
const withEditor = await get(
  '/__svelte-devtools/open?file=' +
    encodeURIComponent('src/Counter.svelte:1:1') +
    '&editor=__nonexistent_editor__'
);
check(
  'editor endpoint accepts file + editor',
  withEditor.status === 200,
  `got ${withEditor.status}: ${withEditor.text.slice(0, 120)}`
);

// The plugin must not alter production builds.
const prodPlugin = svelteDevtools();
prodPlugin.config({}, { command: 'build' });
check(
  'plugin disables itself for production builds',
  prodPlugin.resolveId.call({}, 'svelte/internal/client', undefined) === null
);

// `server.close()` alone can hang on a lingering keep-alive connection from the
// editor request above, so close the underlying HTTP server explicitly too.
await new Promise((resolve) => {
  server.httpServer?.close(() => resolve());
  server.close().then(resolve);
  setTimeout(resolve, 2000);
});

// ---- part 2: hook behaviour against the real runtime -------------------

console.log('\n=== part 2: hook captures live state ===');

const { bootPlaygroundWithHook } = await import('./harness-hook.js');
const captured = await bootPlaygroundWithHook();

check('hook global installed', !!captured.hook);
check('hook reports protocol version 1', captured.hook?.version === 1);

const counterState = captured.hook?.stateFor({ loc: { file: 'playground/src/Counter.svelte' } });
check('state resolved for Counter', !!counterState, JSON.stringify(counterState));

if (counterState) {
  const keys = Object.keys(counterState);
  console.log(`       Counter keys: ${keys.join(', ') || '(none)'}`);
  check('props captured', keys.includes('label') && keys.includes('start'), keys.join(','));
  check(
    'reactive state captured',
    keys.includes('count') || keys.includes('doubled'),
    keys.join(',')
  );
  check('prop values are correct', counterState.label === 'First', String(counterState.label));
}

const todoState = captured.hook?.stateFor({ loc: { file: 'playground/src/TodoList.svelte' } });
check('state resolved for TodoList', !!todoState, JSON.stringify(Object.keys(todoState ?? {})));
if (todoState) {
  console.log(`       TodoList keys: ${Object.keys(todoState).join(', ')}`);
  check('array state captured', Array.isArray(todoState.items), typeof todoState.items);
}

// Writing through the proxy must update the live DOM.
if (captured.hook && todoState && Array.isArray(todoState.items)) {
  const target = captured.hook.targetFor(
    { loc: { file: 'playground/src/TodoList.svelte' } },
    ['items', '0']
  );
  check('targetFor resolves a nested path', !!target, JSON.stringify(target));
  if (target) {
    target.text = 'edited from devtools';
    captured.flushSync();
    const rendered = [...captured.document.querySelectorAll('span')].some(
      (s) => s.textContent === 'edited from devtools'
    );
    check('writing to state updates the DOM', rendered);
  }
}

console.log(
  `\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S): ${failures.join(', ')}`}`
);
process.exit(failures.length === 0 ? 0 : 1);
