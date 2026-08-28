import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

// Match the devtools theme so the panel does not look out of place.
if (chrome.devtools.panels.themeName === 'dark') {
  document.body.classList.add('dark');
}

export default mount(App, { target: document.body });
