import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import fs from 'node:fs';
import { AppConfigSchema } from '../configSchema';
import { createProject } from '../project';
import { hourlyFromElectricityInput } from './consumption';
import { runSimulation } from './optimizer';
import { sum } from './time';

const cfg = AppConfigSchema.parse(YAML.parse(fs.readFileSync('public/config/assumptions.yaml','utf8')));

describe('motori MVP', () => {
  it('conserva il totale annuo nei profili sintetici', () => {
    const p = createProject(cfg);
    const hourly = hourlyFromElectricityInput(p.currentHome.electricityInput, p.currentHome.occupancyProfile, cfg);
    expect(hourly).toHaveLength(8760);
    expect(sum(hourly)).toBeCloseTo(p.currentHome.electricityInput.annualKwh!, 6);
  });
  it('genera tre scenari e bilanci energetici coerenti', () => {
    const p = createProject(cfg);
    const results = runSimulation(p, cfg);
    expect(results).toHaveLength(3);
    for (const r of results) {
      const lhs = sum(r.hourlyFlows.map(f => f.pv + f.gridImport + f.batteryDischarge));
      const rhs = sum(r.hourlyFlows.map(f => f.load + f.batteryCharge + f.gridExport + f.batteryLoss));
      expect(lhs).toBeCloseTo(rhs, 1);
      expect(r.economics.paybackYears === null || Number.isFinite(r.economics.paybackYears)).toBe(true);
    }
  });
});
