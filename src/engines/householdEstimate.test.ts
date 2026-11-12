import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import { AppConfigSchema } from '../configSchema';
import { createProject } from '../project';
import { applyHouseholdEstimate, estimateHouseholdElectricity, HOUSEHOLD_ESTIMATE_FLAG, initialEstimateAnswers } from './householdEstimate';
import { hourlyFromElectricityInput } from './consumption';
import { runSimulation } from './optimizer';

const config = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml', 'utf8')));
const project = () => createProject(config);
const answers = () => ({ ...initialEstimateAnswers(project().currentHome), occupants: 3, floorAreaM2: 100, dishwasher: false, dryer: false, cooling: false, induction: false, electricHotWater: false, heating: 'gas' as const });

describe('stima domestica', () => {
  it('stima una base esplicita e somma solo le dotazioni selezionate', () => {
    expect(estimateHouseholdElectricity(answers()).annualKwh).toBe(2050);
    const estimated = estimateHouseholdElectricity({ ...answers(), dishwasher: true, dryer: true, cooling: true, induction: true, electricHotWater: true, heating: 'heatPump' });
    expect(estimated.annualKwh).toBe(8100);
    expect(estimated.items).toHaveLength(7);
    expect(estimateHouseholdElectricity({ ...answers(), heating: 'resistance' }).annualKwh).toBe(11050);
  });
  it.each([0, -1, 1.5, 21, NaN, Infinity])('rifiuta occupanti non validi: %s', occupants => {
    expect(() => estimateHouseholdElectricity({ ...answers(), occupants })).toThrow();
  });
  it.each([0, 9, 1001, NaN, Infinity])('rifiuta superfici non valide: %s', floorAreaM2 => {
    expect(() => estimateHouseholdElectricity({ ...answers(), floorAreaM2 })).toThrow();
  });
  it('conferma solo il carico attuale, conserva gli altri dati e rimuove serie obsolete', () => {
    const original = project();
    original.currentHome.electricityInput = { mode: 'monthly', monthlyKwh: Array(12).fill(400), hourlyKwh: Array(8760).fill(1), qualityFlags: [] };
    const updated = applyHouseholdEstimate(original, answers());
    expect(original.currentHome.electricityInput.mode).toBe('monthly');
    expect(updated.currentHome.electricityInput).toEqual({ mode: 'annual', annualKwh: 2050, qualityFlags: [HOUSEHOLD_ESTIMATE_FLAG], estimateAnswers: answers() });
    expect(updated.roof).toBe(original.roof);
    expect(updated.futureHome).toBe(original.futureHome);
    expect(updated.mobility).toBe(original.mobility);
    expect(updated.currentHome.heating.gasSmcYear).toBe(original.currentHome.heating.gasSmcYear);
    expect(initialEstimateAnswers(JSON.parse(JSON.stringify(updated.currentHome)))).toEqual(answers());
    const hourly = hourlyFromElectricityInput(updated.currentHome.electricityInput, updated.currentHome.occupancyProfile, config);
    expect(hourly.reduce((a, b) => a + b, 0)).toBeCloseTo(2050, 5);
  });
  it('segnala nei risultati che i consumi sono stimati', () => {
    const results = runSimulation(applyHouseholdEstimate(project(), answers()), config);
    expect(results.every(result => result.confidence === 'Indicativa')).toBe(true);
    expect(results.every(result => result.warnings.some(warning => warning.includes(HOUSEHOLD_ESTIMATE_FLAG)))).toBe(true);
  });
});
