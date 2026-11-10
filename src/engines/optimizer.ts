import type { AppConfig, Project, ScenarioObjective, ScenarioResult } from '../types';
import { hourlyFromElectricityInput } from './consumption';
import { futureHomeExtraLoads, evHomeLoad } from './electrification';
import { economics } from './economics';
import { hourlyPvProduction } from './solar';
import { simulateBattery } from './simulation';
import { monthForHour, sum } from './time';

export function runSimulation(project: Project, cfg: AppConfig): ScenarioResult[] {
  const baseLoad = hourlyFromElectricityInput(project.currentHome.electricityInput, project.currentHome.occupancyProfile, cfg);
  const extra = futureHomeExtraLoads(project.currentHome, project.futureHome, cfg);
  const ev = evHomeLoad(project.mobility, cfg);
  if (project.mobility.smartChargingEnabled && project.mobility.chargingProfile === 'solar') shiftEvTowardSolar(ev);
  const load = baseLoad.map((v,i)=>v + extra[i] + ev[i]);
  const maxPanels = Math.max(1, project.roof.manualCapacityOverride ?? project.roof.planes.filter(p=>p.usable).reduce((a,p)=>a+p.panels.length,0));
  const candidates: ScenarioResult[] = [];
  for (const frac of cfg.optimizer.candidatePanelFractions as number[]) {
    const panels = Math.max(1, Math.round(maxPanels * frac));
    const kwp = panels * cfg.pv.panel.powerWp / 1000;
    const pv = hourlyPvProduction(project.roof, panels, cfg);
    for (const b of cfg.battery.candidateKwh as number[]) candidates.push(buildResult(project, cfg, pv, load, panels, kwp, b, baseLoad));
  }
  const minBill = pick(candidates, 'minBill');
  const maxSelf = pick(candidates.filter(c => c.economics.savings >= cfg.optimizer.minEconomicUtilityEur || c.annualMetrics.pvKwh > 0), 'maxSelfConsumption');
  const maxRoi = pick(candidates, 'maxROI');
  const selected = [minBill, maxSelf, maxRoi].map((r,i) => ({ ...r, objective: ['minBill','maxSelfConsumption','maxROI'][i] as ScenarioObjective }));
  const bestScore = Math.max(...selected.map(s => recommendationScore(s)));
  return selected.map(s => ({ ...s, score: recommendationScore(s), explanationTokens: [...s.explanationTokens, recommendationScore(s) === bestScore ? 'recommended' : 'compared'] }));
}

function buildResult(project: Project, cfg: AppConfig, pv: number[], load: number[], panels: number, kwp: number, batteryKwh: number, baseLoad: number[]): ScenarioResult {
  const flows = simulateBattery(pv, load, batteryKwh, cfg);
  const pvKwh = sum(flows.map(f=>f.pv)), loadKwh = sum(flows.map(f=>f.load));
  const gridImportKwh = sum(flows.map(f=>f.gridImport)), gridExportKwh = sum(flows.map(f=>f.gridExport));
  const batteryThroughputKwh = sum(flows.map(f=>f.batteryDischarge));
  const directSelfKwh = sum(flows.map(f=>Math.min(f.pv, f.load)));
  const eco = economics({ baselineKwh: sum(baseLoad), importKwh: gridImportKwh, exportKwh: gridExportKwh, kwp, batteryKwh, tariffs: project.tariffs, cfg, mobility: project.mobility, baselineGasSmc: project.currentHome.heating.gasSmcYear ?? 0, scenarioGasSmc: project.futureHome.gasRemoved ? 0 : project.currentHome.heating.gasSmcYear ?? 0 });
  const monthlyAggregates = Array.from({length:12},(_,m)=>({month:m+1,pv:0,load:0,import:0,export:0}));
  flows.forEach((f,i)=>{ const m=monthlyAggregates[monthForHour(i)]; m.pv+=f.pv; m.load+=f.load; m.import+=f.gridImport; m.export+=f.gridExport; });
  const warnings = ['Non include ombre locali: serve verifica professionale.', 'Dati solari sintetici: risultato orientativo.'];
  if (project.roof.manualCapacityOverride) warnings.push('Capacità pannelli forzata: geometria non verificata.');
  const confidence = confidenceLevel(project);
  return { objective: 'minBill', pvConfiguration: { kwp, panelCount: panels, planes: project.roof.planes.filter(p=>p.usable).map(p=>p.label) }, batteryConfiguration: { capacityKwh: batteryKwh }, hourlyFlows: flows, monthlyAggregates, annualMetrics: { pvKwh, loadKwh, directSelfKwh, batteryThroughputKwh, gridImportKwh, gridExportKwh, selfConsumptionPct: pvKwh ? (directSelfKwh + batteryThroughputKwh) / pvKwh * 100 : 0, selfSufficiencyPct: loadKwh ? (loadKwh-gridImportKwh)/loadKwh*100 : 0 }, economics: eco, explanationTokens: explanation(kwp,batteryKwh,eco.savings,eco.paybackYears), warnings, confidence, score: 0 };
}
function pick(c: ScenarioResult[], objective: ScenarioObjective) { return [...c].sort((a,b) => objective === 'minBill' ? (a.economics.scenarioCost-a.economics.exportRevenue)-(b.economics.scenarioCost-b.economics.exportRevenue) : objective === 'maxSelfConsumption' ? b.annualMetrics.selfConsumptionPct-a.annualMetrics.selfConsumptionPct || b.economics.savings-a.economics.savings : (a.economics.paybackYears ?? 999)-(b.economics.paybackYears ?? 999) || b.economics.savings-a.economics.savings)[0]; }
function recommendationScore(r: ScenarioResult) { return r.economics.savings/1000 - (r.economics.paybackYears ?? 25)/10 - r.economics.investment/50000 + (100-r.annualMetrics.selfSufficiencyPct)/1000; }
function explanation(kwp:number,battery:number,savings:number,payback:number|null) { return [`${kwp.toFixed(1)} kWp dimensionati sui consumi futuri`, battery>0?`accumulo da ${battery} kWh per aumentare autosufficienza`:'senza accumulo perché il beneficio marginale è limitato', savings>0?`risparmio stimato ${Math.round(savings)} €/anno`:'risparmio non positivo', payback?`payback semplice ${payback.toFixed(1)} anni`:'payback non raggiunto']; }
function confidenceLevel(p: Project) { if (p.currentHome.electricityInput.mode === 'hourly') return 'Alta'; if (p.currentHome.electricityInput.mode === 'monthly') return 'Buona'; return 'Indicativa'; }
function shiftEvTowardSolar(load: number[]) { /* profilo solar già concentra nelle ore centrali; hook esplicito per futura ottimizzazione */ return load; }
