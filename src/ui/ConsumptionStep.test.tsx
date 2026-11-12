// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import { AppConfigSchema } from '../configSchema';
import { createProject } from '../project';
import type { Project } from '../types';
import { ConsumptionStep } from './App';
import { HOUSEHOLD_ESTIMATE_FLAG } from '../engines/householdEstimate';

const config = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml', 'utf8')));
let root: Root;
let container: HTMLDivElement;
let latest: Project;
const onContinue = vi.fn();
const onBack = vi.fn();
const onSave = vi.fn();
async function mount(initial = createProject(config)) {
  function Harness() {
    const [project, setProject] = useState(initial);
    latest = project;
    return <ConsumptionStep project={project} update={setProject} onContinue={onContinue} onBack={onBack} onSave={onSave} />;
  }
  await act(async () => root.render(<Harness />));
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(element => element.textContent?.includes(text));
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('percorso guidato consumi', () => {
  it('propone il wizard prima dei valori tecnici e permette di saltarlo senza cambiare i dati', async () => {
    const initial = createProject(config);
    await mount(initial);
    expect(container.textContent).toContain('Parlaci della tua casa');
    expect(container.querySelector('.consumption-manual')).toBeNull();
    await click('Ho già i consumi');
    expect(container.querySelector('.consumption-manual')).not.toBeNull();
    expect(latest).toBe(initial);
    expect(container.textContent).not.toContain('Dettagliata: oraria');
    await click('Salva');
    expect(onSave).toHaveBeenCalledOnce();
    await click('Continua alla casa futura');
    expect(onContinue).toHaveBeenCalledOnce();
  });
  it('conserva le risposte tornando indietro e applica la stima solo su conferma', async () => {
    const initial = createProject(config);
    await mount(initial);
    await click('Continua');
    const dishwasher = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => dishwasher.click());
    await click('Indietro');
    await click('Continua');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    await click('Mostra la stima');
    expect(container.textContent).toContain('kWh/anno');
    expect(latest).toBe(initial);
    expect(document.activeElement?.textContent).toBe('Ecco la tua stima di consumo');
    await click('Usa questa stima');
    expect(latest.currentHome.electricityInput.estimateAnswers?.dishwasher).toBe(true);
    expect(latest.currentHome.electricityInput.qualityFlags).toContain(HOUSEHOLD_ESTIMATE_FLAG);
    expect(onContinue).toHaveBeenCalledOnce();
    expect(container.querySelector('.consumption-manual')).toBeNull();
    await click('Ho già i consumi');
    expect(container.querySelector('.consumption-wizard')).toBeNull();
    const annual = container.querySelector<HTMLInputElement>('.consumption-manual input[type="number"]')!;
    await fill(annual, '4200');
    expect(latest.currentHome.electricityInput.annualKwh).toBe(4200);
    expect(latest.currentHome.electricityInput.qualityFlags).not.toContain(HOUSEHOLD_ESTIMATE_FLAG);
    expect(latest.currentHome.electricityInput.estimateAnswers).toBeUndefined();
  });
  it('riapre il wizard e non il modulo manuale quando esiste già una stima', async () => {
    const initial = createProject(config);
    await mount(initial);
    await click('Continua');
    await click('Mostra la stima');
    await click('Usa questa stima');
    const saved = latest;
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(saved);
    expect(container.querySelector('.consumption-manual')).toBeNull();
    expect(container.textContent).toContain('Parlaci della tua casa');
    await click('Ho già i consumi');
    expect(container.querySelector('.consumption-manual')).not.toBeNull();
    expect(container.querySelector('.consumption-wizard')).toBeNull();
  });
  it('blocca valori impossibili e consente il ritorno al tetto', async () => {
    await mount();
    await fill(container.querySelector<HTMLInputElement>('input')!, '0');
    expect(button('Continua').disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await fill(container.querySelector<HTMLInputElement>('input')!, '4');
    expect(button('Continua').disabled).toBe(false);
    await click('Indietro');
    expect(onBack).toHaveBeenCalledOnce();
  });
});
