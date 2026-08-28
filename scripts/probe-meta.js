/**
 * Mounts the playground app under jsdom with dev-compiled Svelte and dumps the
 * real `__svelte_meta` structures, so the tree builder can be developed against
 * observed runtime data rather than assumptions.
 *
 * Run: node --experimental-strip-types scripts/probe-meta.js   (or just `node scripts/probe-meta.js`)
 */
import { JSDOM } from 'jsdom';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost:5273/',
  pretendToBeVisual: true
});

// Svelte's client runtime reads these off the global scope at module init.
for (const key of [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Comment',
  'DocumentFragment',
  'CustomEvent',
  'Event',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle'
]) {
  if (globalThis[key] === undefined && dom.window[key] !== undefined) {
    globalThis[key] = dom.window[key];
  }
}

/**
 * Compiles every .svelte file on demand and serves it through a generated .mjs
 * file so `import` works without a bundler. Self-referencing components (a
 * component importing itself for recursion) are handled by registering a lazy
 * namespace proxy in the cache *before* resolving dependencies.
 */
const cache = new Map();
globalThis.__deps = {};

async function load(file) {
  const abs = resolve(file);
  if (cache.has(abs)) return cache.get(abs);

  // Register a lazy placeholder first so a cyclic import resolves instead of
  // recursing forever. The proxy defers to the real module once it exists.
  const pending = { resolved: null };
  const placeholder = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === 'default') {
          // Return a wrapper so recursion works even before the module settles.
          return (...args) => pending.resolved.default(...args);
        }
        return pending.resolved?.[prop];
      }
    }
  );
  cache.set(abs, placeholder);

  const source = readFileSync(abs, 'utf8');
  const relative = abs.slice(root.length + 1).replace(/\\/g, '/');
  const { js } = compile(source, {
    filename: relative,
    dev: true,
    generate: 'client'
  });

  // Resolve relative component imports to injected globals. Only rewrite
  // imports that actually bind something; bare side-effect imports
  // (`import 'svelte/internal/disclose-version'`) must be left alone.
  // `import X from './C.svelte'` binds the *default* export, so unwrap it.
  const deps = new Map();
  let code = js.code.replace(
    /import\s+([^;'"]+?)\s+from\s+['"](\.[^'"]+)['"];/g,
    (match, clause, spec) => {
      const target = resolve(dirname(abs), spec);
      const alias = `d${cache.size}_${deps.size}`;
      deps.set(alias, target);
      const trimmed = clause.trim();
      if (trimmed.startsWith('*')) {
        return `const ${trimmed.replace(/^\*\s+as\s+/, '')} = globalThis.__deps.${alias};`;
      }
      if (trimmed.startsWith('{')) {
        return `const ${trimmed} = globalThis.__deps.${alias};`;
      }
      // default import
      return `const ${trimmed} = globalThis.__deps.${alias}.default;`;
    }
  );

  for (const [alias, target] of deps) {
    globalThis.__deps[alias] = target.endsWith('.svelte')
      ? await load(target)
      : await import(pathToFileURL(target).href);
  }

  const outDir = join(root, 'node_modules', '.probe');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, relative.replace(/[\\/]/g, '_') + '.mjs');
  writeFileSync(outFile, code);

  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
  pending.resolved = mod;
  cache.set(abs, mod);
  return mod;
}

const { mount, flushSync } = await import('svelte');
const App = (await load(join(root, 'playground/src/App.svelte'))).default;

mount(App, { target: dom.window.document.getElementById('app') });
flushSync();

// ---- report -------------------------------------------------------------

const doc = dom.window.document;
const all = [...doc.querySelectorAll('*')];
const withMeta = all.filter((el) => el.__svelte_meta);

console.log(`total elements: ${all.length}`);
console.log(`elements with __svelte_meta: ${withMeta.length}`);
console.log(`window.__svelte: ${JSON.stringify(dom.window.__svelte && { v: [...(dom.window.__svelte.v ?? [])] })}`);

function chain(meta) {
  const out = [];
  let entry = meta.parent;
  while (entry) {
    out.push(
      `${entry.type}${entry.componentTag ? `<${entry.componentTag}>` : ''}@${entry.file}:${entry.line}:${entry.column}`
    );
    entry = entry.parent;
  }
  return out;
}

console.log('\n--- per-element metadata ---');
for (const el of withMeta) {
  const m = el.__svelte_meta;
  const label = `<${el.tagName.toLowerCase()}${el.className ? ` class="${el.className}"` : ''}>`;
  console.log(`\n${label}`);
  console.log(`  loc:   ${m.loc.file}:${m.loc.line}:${m.loc.column}`);
  console.log(`  chain: ${chain(m).join('  <-  ') || '(none)'}`);
}

// Are DevStackEntry objects identity-stable / shared between siblings?
console.log('\n--- entry identity check ---');
const seen = new Map();
for (const el of withMeta) {
  let entry = el.__svelte_meta.parent;
  while (entry) {
    if (!seen.has(entry)) seen.set(entry, []);
    seen.get(entry).push(el.tagName.toLowerCase());
    entry = entry.parent;
  }
}
console.log(`unique DevStackEntry objects reachable: ${seen.size}`);
for (const [entry, els] of seen) {
  if (els.length > 1) {
    console.log(
      `  shared by ${els.length} elements: ${entry.type}${entry.componentTag ? `<${entry.componentTag}>` : ''} @${entry.file}:${entry.line} -> ${els.join(', ')}`
    );
  }
}
