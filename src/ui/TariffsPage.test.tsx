// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import { AppConfigSchema } from '../configSchema';
import { createProject } from '../project';
import type { Project } from '../types';
import { effectiveConfig } from '../assumptions';
import { TariffsPage } from './TariffsPage';
import { App } from './App';
import { loadDraftProject, saveDraftProject } from '../persistence';

vi.mock('../persistence', async importOriginal => ({
  ...await importOriginal<typeof import('../persistence')>(),
  listProjects: vi.fn(async () => []), loadDraftProject: vi.fn(), saveDraftProject: vi.fn(),
}));
const config = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml', 'utf8')));
let root: Root;
let container: HTMLDivElement;
let latest: Project;
async function mountPage() {
  function Harness() {
    const [project, setProject] = useState(createProject(config));
    latest = project;
    return <TariffsPage project={project} update={setProject} baseConfig={config} config={effectiveConfig(config, project.assumptionOverrides)} />;
  }
  await act(async () => root.render(<Harness />));
}
async function click(text: string) {
  const element = [...container.querySelectorAll('button, a')].find(element => element.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button/link: ${text}`);
  await act(async () => (element as HTMLElement).click());
}
async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.mocked(loadDraftProject).mockReturnValue(undefined);
  window.history.replaceState(null, '', '/');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('pagina prezzi esperta', () => {
  it('separa i contesti e applica tariffe, prezzo mobilità e override tecnici solo su conferma', async () => {
    await mountPage();
    const original = latest;
    expect(container.textContent).toContain('Modifica questi valori solo se sai quello che stai facendo o sei esperto.');
    expect(container.querySelectorAll('table').length).toBeGreaterThan(10);
    expect(container.textContent).toContain('Costanti del modello · sola lettura');
    await fill('Energia acquistata', '0.44');
    await fill('Prezzo energia del veicolo attuale', '2.1');
    await fill('SCOP della pompa di calore', '4.5');
    await fill('Costo totale fotovoltaico manuale', '0');
    expect(latest).toBe(original);
    await click('Applica modifiche');
    expect(latest.tariffs.gridPurchaseEurKwh).toBe(0.44);
    expect(latest.tariffs.pvCostOverride).toBe(0);
    expect(latest.mobility.currentVehicle.price).toBe(2.1);
    expect(latest.tariffs.fuelEurLiter).toBe(2.1);
    expect(latest.assumptionOverrides).toEqual({ 'electrification.heatPumpScop': 4.5 });
    expect(latest.results).toBeUndefined();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Modifiche applicate');
    await fill('Costo totale fotovoltaico manuale', '');
    await click('Applica modifiche');
    expect(latest.tariffs.pvCostOverride).toBeUndefined();
  });
  it('rifiuta modifiche non valide in modo atomico, senza azzerare dati esistenti', async () => {
    await mountPage();
    const original = latest;
    await fill('Energia acquistata', '0.5');
    await fill('Performance ratio', '2');
    await fill('Presenza: mattina', '[1,2]');
    await click('Applica modifiche');
    expect(latest).toBe(original);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Modifiche non applicate');
    expect(container.querySelectorAll('[aria-invalid="true"]').length).toBe(2);
  });
  it('ripristina i parametri tecnici senza cambiare tariffe e richiede conferma', async () => {
    await mountPage();
    await fill('SCOP della pompa di calore', '5');
    await fill('Energia acquistata', '0.4');
    await click('Applica modifiche');
    await click('Ripristina parametri tecnici predefiniti');
    expect(latest.assumptionOverrides).toEqual({ 'electrification.heatPumpScop': 5 });
    await click('Applica modifiche');
    expect(latest.assumptionOverrides).toEqual({});
    expect(latest.tariffs.gridPurchaseEurKwh).toBe(0.4);
  });
});

describe('prezzi fuori dal percorso principale', () => {
  it('mostra solo cinque passi nel menu e apre prezzi dal link nel footer anche via cronologia', async () => {
    window.history.replaceState(null, '', '/consumi');
    await act(async () => root.render(<App config={config} />));
    const menu = container.querySelector('nav[aria-label="Step di configurazione"]')!;
    expect(menu.querySelectorAll('button')).toHaveLength(5);
    expect(menu.textContent).not.toContain('Prezzi');
    expect(container.querySelector('.settings-footer a')?.getAttribute('href')).toBe('/prezzi');
    await click('Prezzi e assunzioni · impostazioni esperte');
    expect(window.location.pathname).toBe('/prezzi');
    expect(container.querySelector('h1')?.textContent).toBe('Prezzi e assunzioni');
    window.history.replaceState(null, '', '/consumi');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(container.querySelector('h1')?.textContent).toBe('Consumi attuali');
  });
  it('passa da Mobilità ai risultati senza transitare per Prezzi e torna a Mobilità', async () => {
    window.history.replaceState(null, '', '/mobilita');
    await act(async () => root.render(<App config={config} />));
    await click('Avanti');
    expect(window.location.pathname).toBe('/risultati');
    expect(container.querySelector('.tariffs-page')).toBeNull();
    expect(vi.mocked(saveDraftProject).mock.calls.at(-1)?.[0].results).toHaveLength(3);
    await click('Indietro');
    expect(window.location.pathname).toBe('/mobilita');
  });
  it('mantiene stabile la configurazione tornando al tetto con override tecnici', async () => {
    const project = createProject(config);
    project.assumptionOverrides = { 'electrification.heatPumpScop': 4.5 };
    vi.mocked(loadDraftProject).mockReturnValue(project);
    window.history.replaceState(null, '', '/tetto');
    await act(async () => root.render(<App config={config} />));
    expect(window.location.pathname).toBe('/tetto');
    expect(vi.mocked(saveDraftProject).mock.calls.length).toBeLessThanOrEqual(3);
    const saved = vi.mocked(saveDraftProject).mock.calls.at(-1)?.[0];
    expect(saved?.assumptionOverrides).toEqual(project.assumptionOverrides);
  });
  it('usa i parametri salvati nel progetto nel calcolo degli scenari', async () => {
    const project = createProject(config);
    project.assumptionOverrides = { 'pv.installationCost.fixedEur': 12000, 'pv.installationCost.variableEurPerKwp': 0, 'battery.candidateKwh': [0] };
    vi.mocked(loadDraftProject).mockReturnValue(project);
    window.history.replaceState(null, '', '/prezzi');
    await act(async () => root.render(<App config={config} />));
    await click('Calcola scenari');
    const results = vi.mocked(saveDraftProject).mock.calls.at(-1)?.[0].results;
    expect(results).toHaveLength(3);
    expect(results?.every(result => result.economics.investment === 12000)).toBe(true);
  });
});
