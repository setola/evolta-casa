import type { AppConfig, Roof } from '../types';
import { DAYS_IN_MONTH } from './time';

export function hourlyPvProduction(roof: Roof, panelCount: number, cfg: AppConfig) {
  const kwp = panelCount * cfg.pv.panel.powerWp / 1000;
  const usable = roof.planes.filter(p => p.usable);
  const avgAzimuth = usable.length ? usable.reduce((a,p)=>a+p.azimuthDeg,0)/usable.length : 180;
  const avgPitch = usable.length ? usable.reduce((a,p)=>a+p.pitchDeg,0)/usable.length : 30;
  const azLoss = Math.abs(avgAzimuth - 180) / 90 * cfg.solar.azimuthLossPer90Deg;
  const pitchLoss = Math.abs(avgPitch - cfg.solar.pitchOptimalDeg) / 30 * cfg.solar.pitchLossPer30Deg;
  const factor = Math.max(0.55, 1 - azLoss - pitchLoss) * cfg.solar.performanceRatio / 0.82;
  const out: number[] = [];
  for (let m=0;m<12;m++) {
    const monthly = cfg.solar.monthlyKwhPerKwp[m] * kwp * factor;
    const daylight = daylightWeights(m);
    const daily = monthly / DAYS_IN_MONTH[m];
    for (let d=0; d<DAYS_IN_MONTH[m]; d++) for (let h=0; h<24; h++) out.push(daily * daylight[h]);
  }
  return out;
}
function daylightWeights(month: number) {
  const length = [8,9,11,13,14,15,15,14,12,10,9,8][month];
  const start = Math.round(12 - length/2);
  const raw = Array(24).fill(0).map((_,h) => h < start || h > start+length ? 0 : Math.sin(Math.PI * (h-start)/length));
  const s = raw.reduce((a,b)=>a+b,0) || 1; return raw.map(v=>v/s);
}
