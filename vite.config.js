import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Builds the devtools panel UI. The MAIN-world agent and the service worker are
 * built separately by Rollup, because they must be plain scripts with no import
 * of the Svelte runtime.
 *
 * Vite runs first and owns `emptyOutDir`; Rollup then writes `agent.js` and
 * `background.js` into the same directory. Doing it the other way round makes
 * Vite delete the Rollup output.
 */
export default defineConfig({
  plugins: [svelte()],
  // `static/` is copied verbatim: manifest, devtools page, icons.
  publicDir: 'static',
  build: {
    outDir: 'build',
    emptyOutDir: true,
    target: 'chrome121',
    rollupOptions: {
      input: { index: 'index.html' }
    }
  }
});
