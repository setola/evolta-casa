// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import { AppConfigSchema } from '../configSchema';
import { App } from './App';

vi.hoisted(() => vi.stubEnv('BASE_URL', '/evolta-casa/'));
vi.mock('../persistence', () => ({
  listProjects: vi.fn(async () => []), loadDraftProject: vi.fn(), saveDraftProject: vi.fn(),
  clearAll: vi.fn(), deleteProject: vi.fn(), exportProject: vi.fn(), importProject: vi.fn(), saveProject: vi.fn(),
}));
const config = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml', 'utf8')));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('opens a Pages deep link, navigates within the base and handles popstate', async () => {
  window.history.replaceState(null, '', '/evolta-casa/consumi/');
  await act(async () => root.render(<App config={config} />));
  expect(container.querySelector('h1')?.textContent).toBe('Consumi attuali');
  const prices = container.querySelector<HTMLAnchorElement>('.settings-footer a')!;
  expect(prices.getAttribute('href')).toBe('/evolta-casa/prezzi');
  expect(container.querySelector('.cw-logo')?.getAttribute('src')).toBe('/evolta-casa/ui/logo.svg');
  await act(async () => prices.click());
  expect(window.location.pathname).toBe('/evolta-casa/prezzi');
  expect(container.querySelector('h1')?.textContent).toBe('Prezzi e assunzioni');
  window.history.replaceState(null, '', '/evolta-casa/consumi/');
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(container.querySelector('h1')?.textContent).toBe('Consumi attuali');
  await act(async () => container.querySelector<HTMLAnchorElement>('.cw-brand')!.click());
  expect(window.location.pathname).toBe('/evolta-casa/');
});

it('redirects legacy Pages URLs without losing query or hash', async () => {
  window.history.replaceState(null, '', '/evolta-casa/pannelli/?source=bookmark#roof');
  await act(async () => root.render(<App config={config} />));
  expect(window.location.pathname).toBe('/evolta-casa/tetto');
  expect(window.location.search).toBe('?source=bookmark');
  expect(window.location.hash).toBe('#roof');
});
