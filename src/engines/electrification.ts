import type { AppConfig, CurrentHome, FutureHome, Mobility } from '../types';
import { DAYS_IN_MONTH, HOURS_YEAR, normalize } from './time';

const HEATING_MONTH_WEIGHTS = normalize([0.2,0.18,0.14,0.08,0.03,0,0,0,0.03,0.08,0.12,0.14]);
const DHW_HOURLY = normalize([0.015,0.01,0.008,0.008,0.01,0.025,0.07,0.075,0.05,0.035,0.03,0.035,0.045,0.04,0.035,0.04,0.05,0.065,0.075,0.08,0.075,0.055,0.035,0.024]);
const COOKING_HOURLY = normalize([0,0,0,0,0,0,0.04,0.06,0.03,0,0.02,0.1,0.13,0.02,0,0,0.03,0.12,0.2,0.16,0.08,0.02,0,0]);

export function futureHomeExtraLoads(current: CurrentHome, future: FutureHome, cfg: AppConfig) {
  const out = Array(HOURS_YEAR).fill(0);
  if (future.heatPumpEnabled && current.heating.source === 'gas') {
    const smc = current.heating.gasSmcYear ?? 0;
    const electric = smc * cfg.electrification.kwhThermalPerSmc * cfg.electrification.currentBoilerEfficiency / cfg.electrification.heatPumpScop;
    addMonthlyHourly(out, electric, HEATING_MONTH_WEIGHTS, normalize([0.055,0.055,0.055,0.055,0.055,0.05,0.045,0.035,0.03,0.025,0.02,0.02,0.02,0.02,0.025,0.03,0.04,0.045,0.05,0.055,0.06,0.06,0.06,0.06]));
  }
  if (future.electricHotWaterEnabled && current.hotWater === 'gas') addFlatByHourly(out, current.occupants * cfg.electrification.hotWaterKwhPerPersonYear, DHW_HOURLY);
  if (future.inductionEnabled && current.cooking === 'gas') addFlatByHourly(out, current.occupants * cfg.electrification.inductionKwhPerPersonYear, COOKING_HOURLY);
  return out;
}

export function evHomeLoad(mobility: Mobility, cfg: AppConfig) {
  const out = Array(HOURS_YEAR).fill(0);
  if (!mobility.evEnabled) return out;
  const annual = mobility.futureEv.kmYear * mobility.futureEv.consumptionKwh100km / 100 * mobility.futureEv.homeChargingShare;
  addFlatByHourly(out, annual, normalize(cfg.ev.chargingHourlyWeights[mobility.chargingProfile]));
  return out;
}

function addFlatByHourly(out: number[], annual: number, hourly: number[]) {
  const daily = annual / 365;
  for (let d=0; d<365; d++) for (let h=0; h<24; h++) out[d*24+h] += daily * hourly[h];
}
function addMonthlyHourly(out: number[], annual: number, monthWeights: number[], hourly: number[]) {
  let idx=0; for (let m=0; m<12; m++) { const daily = annual * monthWeights[m] / DAYS_IN_MONTH[m]; for (let d=0; d<DAYS_IN_MONTH[m]; d++) for (let h=0; h<24; h++) out[idx++] += daily * hourly[h]; }
}
