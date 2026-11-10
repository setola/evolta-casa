import type { AppConfig, HourlyFlow } from '../types';

export function simulateBattery(pv: number[], load: number[], batteryKwh: number, cfg: AppConfig): HourlyFlow[] {
  const usable = batteryKwh * cfg.battery.usableShare;
  const maxPower = Math.max(0, batteryKwh * cfg.battery.maxPowerKwPerKwh);
  const eta = Math.sqrt(cfg.battery.roundTripEfficiency);
  let soc = usable * cfg.battery.initialSocShare;
  return pv.map((pvKwh, i) => {
    const loadKwh = load[i] ?? 0;
    const direct = Math.min(pvKwh, loadKwh);
    let surplus = pvKwh - direct;
    let deficit = loadKwh - direct;
    const chargeFromPv = batteryKwh > 0 ? Math.min(surplus, maxPower, (usable - soc) / eta) : 0;
    soc += chargeFromPv * eta; surplus -= chargeFromPv;
    const discharge = batteryKwh > 0 ? Math.min(deficit / eta, maxPower, soc) : 0;
    soc -= discharge; deficit -= discharge * eta;
    return { pv: pvKwh, load: loadKwh, batteryCharge: chargeFromPv * eta, batteryDischarge: discharge, gridImport: Math.max(0, deficit), gridExport: Math.max(0, surplus), batteryLoss: chargeFromPv * (1-eta) + discharge * (1-eta), soc };
  });
}
