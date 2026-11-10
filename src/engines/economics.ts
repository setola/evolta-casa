import type { AppConfig, Economics, Mobility, Tariffs } from '../types';

export function pvCost(kwp: number, cfg: AppConfig, override?: number) { return override ?? (cfg.pv.installationCost.fixedEur + kwp * cfg.pv.installationCost.variableEurPerKwp); }
export function batteryCost(kwh: number, cfg: AppConfig, override?: number) { return kwh <= 0 ? 0 : override ?? (cfg.battery.cost.fixedEur + kwh * cfg.battery.cost.variableEurPerKwh); }
export function mobilityCostBeforeAfter(m: Mobility) {
  const before = m.currentVehicle.kind === 'electric'
    ? m.currentVehicle.kmYear * m.currentVehicle.consumption / 100 * m.currentVehicle.price
    : m.currentVehicle.kmYear * m.currentVehicle.consumption / 100 * m.currentVehicle.price;
  const after = m.evEnabled ? m.futureEv.kmYear * m.futureEv.consumptionKwh100km / 100 * m.futureEv.homeChargingShare * 0.30 : before;
  return { before, after };
}
export function economics(args: { baselineKwh: number; importKwh: number; exportKwh: number; kwp: number; batteryKwh: number; tariffs: Tariffs; cfg: AppConfig; mobility: Mobility; baselineGasSmc: number; scenarioGasSmc: number }): Economics {
  const mob = mobilityCostBeforeAfter(args.mobility);
  const baselineCost = args.baselineKwh * args.tariffs.gridPurchaseEurKwh + args.baselineGasSmc * args.tariffs.gasEurSmc + mob.before;
  const scenarioCost = args.importKwh * args.tariffs.gridPurchaseEurKwh + args.scenarioGasSmc * args.tariffs.gasEurSmc + mob.after;
  const exportRevenue = args.exportKwh * args.tariffs.exportEurKwh;
  const investment = pvCost(args.kwp, args.cfg, args.tariffs.pvCostOverride) + batteryCost(args.batteryKwh, args.cfg, args.tariffs.batteryCostOverride);
  const savings = baselineCost - scenarioCost + exportRevenue;
  return { baselineCost, scenarioCost, exportRevenue, savings, investment, paybackYears: savings > 0 ? investment / savings : null, mobilityBefore: mob.before, mobilityAfter: mob.after };
}
