import React from 'react';
import { createRoot } from 'react-dom/client';
import YAML from 'yaml';
import { App } from './ui/App';
import { AppConfigSchema } from './configSchema';
import './styles.css';
import { publicPath } from './paths';

async function boot() {
  const res = await fetch(publicPath('/config/assumptions.yaml'));
  const raw = await res.text();
  const config = AppConfigSchema.parse(YAML.parse(raw));
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App config={config} /></React.StrictMode>);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register(publicPath('/sw.js')).catch(() => undefined);
}
boot().catch(err => {
  const pre = document.createElement('pre');
  pre.style.padding = '2rem';
  pre.style.color = '#991b1b';
  pre.textContent = `Errore avvio: ${err instanceof Error ? err.message : String(err)}`;
  document.body.replaceChildren(pre);
});
