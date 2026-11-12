import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';
import { AppConfigSchema } from './configSchema';
import { ASSUMPTION_FIELDS, configValue, effectiveConfig, isValidAssumption } from './assumptions';
import { createProject } from './project';
import { hourlyPvProduction } from './engines/solar';
import { pvCost } from './engines/economics';
import { exportProject, importProject } from './persistence';

const config = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml', 'utf8')));
describe('parametri esperti per progetto', () => {
  it('descrive e accetta tutti i valori predefiniti esposti', () => {
    expect(new Set(ASSUMPTION_FIELDS.map(field => field.path)).size).toBe(ASSUMPTION_FIELDS.length);
    for (const field of ASSUMPTION_FIELDS) {
      const value = configValue(config, field.path);
      expect(isValidAssumption(field, value, value), field.path).toBe(true);
      expect(field.description.length).toBeGreaterThan(20);
    }
  });
  it('applica le modifiche senza mutare il modello base e ignora percorsi sconosciuti o non validi', () => {
    const customized = effectiveConfig(config, {
      'pv.installationCost.fixedEur': 3000,
      'solar.performanceRatio': 0.41,
      'battery.roundTripEfficiency': 0,
      'consumptionProfiles.monthlyShares': [1, 2],
      'optimizer.candidatePanelFractions': [],
      '__proto__.polluted': 1,
    });
    expect(customized.pv.installationCost.fixedEur).toBe(3000);
    expect(config.pv.installationCost.fixedEur).toBe(1500);
    expect(customized.battery.roundTripEfficiency).toBe(config.battery.roundTripEfficiency);
    expect(customized.consumptionProfiles.monthlyShares).toEqual(config.consumptionProfiles.monthlyShares);
    expect(customized.optimizer.candidatePanelFractions).toEqual(config.optimizer.candidatePanelFractions);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(pvCost(5, customized)).toBe(pvCost(5, config) + 1500);
    const roof = createProject(config).roof;
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    expect(sum(hourlyPvProduction(roof, 10, customized))).toBeCloseTo(sum(hourlyPvProduction(roof, 10, config)) / 2, 5);
  });
  it('rifiuta quote fuori intervallo, vettori vuoti/nulli e numeri non finiti', () => {
    const monthly = ASSUMPTION_FIELDS.find(field => field.path === 'consumptionProfiles.monthlyShares')!;
    expect(isValidAssumption(monthly, Array(12).fill(0), configValue(config, monthly.path))).toBe(false);
    const ratio = ASSUMPTION_FIELDS.find(field => field.path === 'solar.performanceRatio')!;
    for (const value of [0, -1, 1.01, NaN, Infinity, '0.9', [0.9]]) expect(isValidAssumption(ratio, value, 0.82)).toBe(false);
  });
  it('conserva gli override nell’export/import e lascia compatibili i vecchi progetti', () => {
    const project = createProject(config);
    expect(effectiveConfig(config, project.assumptionOverrides)).toBe(config);
    project.assumptionOverrides = { 'electrification.heatPumpScop': 4.1 };
    const reloaded = importProject(exportProject(project));
    expect(effectiveConfig(config, reloaded.assumptionOverrides).electrification.heatPumpScop).toBe(4.1);
  });
});
