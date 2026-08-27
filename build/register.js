/**
 * Devtools page. Creates the panel and keeps it in sync with the Elements
 * panel selection.
 */
chrome.devtools.panels.create('Svelte', 'icons/default-128.png', 'index.html', (panel) => {
  let initialised = false;

  panel.onShown.addListener((panelWindow) => {
    // The Svelte 4 devtools left this commented out, so selecting an element in
    // the Elements panel never reflected into the component tree. Wiring it up
    // makes Elements -> Svelte navigation work in both directions.
    if (!initialised) {
      initialised = true;
      panelWindow.addEventListener('unload', () => {
        initialised = false;
      });
    }

    // `$0` is the Elements panel selection; ask the page which node owns it.
    chrome.devtools.inspectedWindow.eval(
      `window['#SvelteDevTools']?.nodeIdForElement?.($0) ?? null`,
      (id, error) => {
        if (!error && id && panelWindow.__svelteDevtoolsSelectFromElements) {
          panelWindow.__svelteDevtoolsSelectFromElements(id);
        }
      }
    );
  });
});
