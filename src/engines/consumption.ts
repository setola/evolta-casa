import type { AppConfig, CurrentHome, ElectricityInput } from '../types';
import { DAYS_IN_MONTH, HOURS_YEAR, normalize, sum } from './time';

export function hourlyFromElectricityInput(input: ElectricityInput, occupancy: CurrentHome['occupancyProfile'], cfg: AppConfig): number[] {
  if (input.mode === 'hourly' && input.hourlyKwh?.length) return normalizeTo8760(input.hourlyKwh);
  const monthlyShares = normalize(cfg.consumptionProfiles.monthlyShares);
  const monthly = input.mode === 'monthly' && input.monthlyKwh?.length === 12
    ? input.monthlyKwh
    : monthlyShares.map((s: number) => (input.annualKwh ?? 3000) * s);
  const hourlyProfile = normalize(cfg.consumptionProfiles.hourlyByOccupancy[occupancy]);
  const out: number[] = [];
  for (let m=0; m<12; m++) {
    const daily = monthly[m] / DAYS_IN_MONTH[m];
    for (let d=0; d<DAYS_IN_MONTH[m]; d++) for (let h=0; h<24; h++) out.push(daily * hourlyProfile[h]);
  }
  return out;
}

export function normalizeTo8760(values: number[]) {
  const out = values.slice(0, HOURS_YEAR).map(v => Math.max(0, Number.isFinite(v) ? v : 0));
  while (out.length < HOURS_YEAR) out.push(0);
  return out;
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const split = (line: string) => line.split(/[;,]/).map(s => s.trim().replace(/^"|"$/g, ''));
  return { headers: split(lines[0] ?? ''), rows: lines.slice(1).map(split) };
}

export function csvToHourly(text: string, timestampColumn: string, valueColumn: string, unit: 'Wh' | 'kWh') {
  const { headers, rows } = parseCsv(text);
  const ti = headers.indexOf(timestampColumn); const vi = headers.indexOf(valueColumn);
  if (ti < 0 || vi < 0) throw new Error('Colonne CSV non trovate');
  const values = rows.map(r => Math.max(0, Number(String(r[vi]).replace(',', '.')) || 0) / (unit === 'Wh' ? 1000 : 1));
  const factor = Math.max(1, Math.round(values.length / HOURS_YEAR));
  const hourly: number[] = [];
  for (let i=0; i<values.length; i += factor) hourly.push(sum(values.slice(i, i + factor)));
  return normalizeTo8760(hourly);
}
