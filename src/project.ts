import type { AppConfig, Project } from './types';
import { defaultRoofPlane, packPanels } from './engines/roof';
import { newId } from './id';

export function createProject(cfg: AppConfig, sourceSeoPage?: string): Project {
  const plane = defaultRoofPlane();
  const roof = { detectionMethod: 'fixture' as const, confirmedByUser: false, planes: [{...plane, panels: packPanels(plane, cfg)}] };
  const now = new Date().toISOString();
  return { id: newId('project'), schemaVersion: cfg.persistence.schemaVersion, name: 'Nuovo progetto', createdAt: now, updatedAt: now, locale: 'it', sourceSeoPage, assumptionsVersion: cfg.market.assumptionsVersion, roof, currentHome: { floorAreaM2: 120, occupants: 3, occupancyProfile: 'evening', electricityInput: { mode: 'annual', annualKwh: 3200, qualityFlags: ['synthetic-profile'] }, heating: { source: 'gas', gasSmcYear: 900, gasInputMode: 'smc', estimatedFromExpense: false }, hotWater: 'gas', cooking: 'gas', cooling: true }, futureHome: { heatPumpEnabled: true, electricHotWaterEnabled: true, inductionEnabled: true, gasRemoved: true }, mobility: { evEnabled: false, currentVehicle: { kind: 'petrol', kmYear: 12000, consumption: 6.5, price: cfg.energyPrices.fuel.defaultEurPerLiter }, futureEv: { kmYear: 12000, consumptionKwh100km: cfg.ev.defaultConsumptionKwh100Km, homeChargingShare: cfg.ev.defaultHomeChargingShare }, chargingProfile: 'night', smartChargingEnabled: false }, tariffs: { gridPurchaseEurKwh: cfg.energyPrices.electricity.defaultPurchaseEurPerKwh, exportEurKwh: cfg.energyPrices.export.defaultEurPerKwh, gasEurSmc: cfg.energyPrices.gas.defaultEurPerSmc, fuelEurLiter: cfg.energyPrices.fuel.defaultEurPerLiter }, simulationSettings: { preferredObjective: 'minBill', allowSyntheticSolar: true } };
}
export function applyPreset(project: Project, preset?: Record<string, unknown>): Project {
  if (!preset) return project;
  const clone: any = structuredClone(project);
  for (const [path, value] of Object.entries(preset)) { const parts = path.split('.'); let obj = clone; for (const p of parts.slice(0,-1)) obj = obj[p] ??= {}; obj[parts.at(-1)!] = value; }
  return clone;
}
