import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteDevtools } from '../packages/vite-plugin/src/index.js';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The devtools plugin must come first so it can alias the Svelte runtime
  // before vite-plugin-svelte compiles components against it.
  plugins: [svelteDevtools(), svelte()],
  server: { port: 5273 }
});
