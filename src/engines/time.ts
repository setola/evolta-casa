export const HOURS_YEAR = 8760;
export const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];
export function monthForHour(hour: number) { let h=0; for (let m=0;m<12;m++){ h += DAYS_IN_MONTH[m]*24; if (hour < h) return m; } return 11; }
export function dayHour(hour: number) { return hour % 24; }
export function normalize(weights: number[]) { const sum = weights.reduce((a,b)=>a+b,0) || 1; return weights.map(v=>v/sum); }
export function sum(values: number[]) { return values.reduce((a,b)=>a+b,0); }
export function monthlyAggregate(hourly: number[]) { const out = Array(12).fill(0); hourly.forEach((v,i)=>{ out[monthForHour(i)] += v; }); return out; }
