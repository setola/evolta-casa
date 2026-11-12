import type { AppConfig } from './types';

export type AssumptionValue = number | number[];
export interface AssumptionField {
  path: string; label: string; unit: string; description: string;
  min?: number; max?: number; length?: number; positiveSum?: boolean;
}
export interface AssumptionGroup { title: string; description: string; fields: AssumptionField[] }
const field = (path: string, label: string, unit: string, description: string, rules: Partial<AssumptionField> = {}): AssumptionField => ({ path, label, unit, description, min: 0, ...rules });
const share = { min: 0.001, max: 1 };
const profile = (path: string, label: string, length: number, description: string) => field(path, label, 'pesi relativi', description, { length, positiveSum: true });
export const ASSUMPTION_GROUPS: AssumptionGroup[] = [
  { title: 'Investimento fotovoltaico e accumulo', description: 'Costo stimato = quota fissa + taglia × quota variabile. Un costo totale manuale ha precedenza sulla formula.', fields: [
    field('pv.installationCost.fixedEur', 'Fotovoltaico: quota fissa', '€', 'Pratiche, avvio del cantiere e costi indipendenti dalla potenza.'),
    field('pv.installationCost.variableEurPerKwp', 'Fotovoltaico: quota per potenza', '€/kWp', 'Moltiplicata per la potenza installata per stimare l’investimento.'),
    field('battery.cost.fixedEur', 'Batteria: quota fissa', '€', 'Costo iniziale applicato solo quando è presente un accumulo.'),
    field('battery.cost.variableEurPerKwh', 'Batteria: quota per capacità', '€/kWh', 'Moltiplicata per la capacità nominale della batteria.'),
  ] },
  { title: 'Pannelli e superficie del tetto', description: 'Modulo tecnico generico, non un prodotto commerciale. Le modifiche alle dimensioni vengono applicate al layout al prossimo calcolo.', fields: [
    field('pv.panel.powerWp', 'Potenza del modulo', 'Wp', 'Converte il numero di pannelli in potenza fotovoltaica.', { min: 1 }),
    field('pv.panel.widthM', 'Larghezza del modulo', 'm', 'Determina quanti pannelli entrano nella falda.', { min: 0.01 }),
    field('pv.panel.heightM', 'Altezza del modulo', 'm', 'Determina ingombro e disposizione dei moduli.', { min: 0.01 }),
    field('roof.panelMarginM', 'Margine dal bordo', 'm', 'Distanza minima tra pannelli e perimetro della falda.'),
    field('roof.panelSpacingM', 'Spazio tra pannelli', 'm', 'Distanza lasciata tra moduli adiacenti.'),
    ...(['flat', 'low', 'normal', 'steep'] as const).map((key, i) => field(`roof.defaultPitchDeg.${key}`, `Inclinazione predefinita: ${['quasi piano', 'poco inclinato', 'normale', 'molto inclinato'][i]}`, '°', 'Usata assegnando il tipo di tetto; non cambia l’inclinazione di falde già salvate.', { max: 85 })),
  ] },
  { title: 'Produzione solare', description: 'Profilo sintetico medio italiano, non un rilievo del sito né una chiamata PVGIS. Vettori mensili in ordine gennaio–dicembre.', fields: [
    field('solar.monthlyKwhPerKwp', 'Produzione mensile per potenza', 'kWh/kWp/mese', 'Profilo di partenza per calcolare l’energia prodotta ogni mese.', { length: 12, positiveSum: true }),
    field('solar.performanceRatio', 'Performance ratio', 'quota 0–1', 'Corregge la resa rispetto al riferimento del modello (0,82).', share),
    field('solar.azimuthLossPer90Deg', 'Perdita per orientamento', 'quota / 90°', 'Riduce la produzione per lo scostamento dall’orientamento sud.', { max: 1 }),
    field('solar.pitchOptimalDeg', 'Inclinazione ottimale', '°', 'Riferimento per la penalizzazione della pendenza.', { max: 90 }),
    field('solar.pitchLossPer30Deg', 'Perdita per inclinazione', 'quota / 30°', 'Riduce la produzione per lo scostamento dalla pendenza ottimale.', { max: 1 }),
  ] },
  { title: 'Batteria: funzionamento', description: 'Parametri del bilancio energetico orario e taglie confrontate dalla simulazione.', fields: [
    field('battery.candidateKwh', 'Capacità confrontate', 'kWh', 'Elenco delle taglie nominali. Zero rappresenta lo scenario senza accumulo.', { length: undefined, positiveSum: false }),
    field('battery.usableShare', 'Capacità utilizzabile', 'quota 0–1', 'Parte della capacità nominale realmente disponibile.', share),
    field('battery.roundTripEfficiency', 'Rendimento carica/scarica', 'quota 0–1', 'Determina le perdite del ciclo di accumulo.', share),
    field('battery.maxPowerKwPerKwh', 'Potenza per capacità', 'kW/kWh', 'Limita l’energia caricabile o scaricabile in un’ora.', { min: 0.001 }),
    field('battery.initialSocShare', 'Carica iniziale', 'quota 0–1', 'Stato della batteria all’inizio dell’anno simulato.', { max: 1 }),
  ] },
  { title: 'Distribuzione dei consumi domestici', description: 'I pesi vengono normalizzati. I dati mensili o orari reali sostituiscono i profili sintetici corrispondenti. Vettori orari da 00:00 a 23:00.', fields: [
    profile('consumptionProfiles.monthlyShares', 'Distribuzione mensile', 12, 'Ripartisce il consumo annuo sui dodici mesi.'),
    ...(['morning', 'day', 'evening', 'always'] as const).map((key, i) => profile(`consumptionProfiles.hourlyByOccupancy.${key}`, `Presenza: ${['mattina', 'giorno', 'sera', 'sempre'][i]}`, 24, 'Ripartisce il consumo giornaliero nelle 24 ore secondo la presenza in casa.')),
  ] },
  { title: 'Elettrificazione della casa futura', description: 'Carichi aggiuntivi applicati solo quando si sostituisce una dotazione attuale a gas.', fields: [
    field('electrification.kwhThermalPerSmc', 'Energia termica del metano', 'kWh/Smc', 'Converte i metri cubi di gas in energia termica.', { min: 0.001 }),
    field('electrification.currentBoilerEfficiency', 'Rendimento caldaia attuale', 'quota 0–1', 'Stima il calore utile ottenuto dal gas consumato.', share),
    field('electrification.heatPumpScop', 'SCOP della pompa di calore', 'kWh termici/kWh elettrico', 'Divide il fabbisogno termico per stimare l’elettricità necessaria.', { min: 0.1 }),
    field('electrification.hotWaterKwhPerPersonYear', 'Acqua calda elettrica', 'kWh/persona/anno', 'Aggiunge il consumo annuo di acqua calda per ogni occupante.'),
    field('electrification.inductionKwhPerPersonYear', 'Cucina a induzione', 'kWh/persona/anno', 'Aggiunge il consumo annuo della cucina per ogni occupante.'),
  ] },
  { title: 'Mobilità: distribuzione della ricarica', description: 'La quantità di energia dipende da km annui, consumo e quota di ricarica domestica impostati in Mobilità.', fields: [
    ...(['night', 'random', 'solar'] as const).map((key, i) => profile(`ev.chargingHourlyWeights.${key}`, `Ricarica: ${['notturna', 'distribuita', 'nelle ore solari'][i]}`, 24, 'Pesi delle 24 ore, normalizzati per distribuire il carico di ricarica domestica.')),
  ] },
  { title: 'Confronto degli scenari', description: 'Il simulatore confronta combinazioni di potenza FV e batteria e seleziona minimo costo, massimo autoconsumo e miglior ritorno.', fields: [
    field('optimizer.candidatePanelFractions', 'Quote di pannelli da confrontare', 'quota 0–1', 'Frazioni del massimo numero di pannelli disponibili da simulare.', { ...share, positiveSum: true }),
    field('optimizer.minEconomicUtilityEur', 'Soglia di utilità economica', '€/anno', 'Soglia di risparmio nel filtro dello scenario di massimo autoconsumo; passa anche uno scenario con produzione positiva.'),
  ] },
];
export const ASSUMPTION_FIELDS = ASSUMPTION_GROUPS.flatMap(group => group.fields);

export function configValue(config: AppConfig, path: string): AssumptionValue {
  return path.split('.').reduce((value: any, key) => value[key], config);
}
export function isValidAssumption(field: AssumptionField, value: unknown, base: AssumptionValue): value is AssumptionValue {
  const array = Array.isArray(base);
  if (array !== Array.isArray(value)) return false;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 48 || (field.length && values.length !== field.length)) return false;
  if (!values.every(item => typeof item === 'number' && Number.isFinite(item) && item >= (field.min ?? 0) && item <= (field.max ?? Number.MAX_SAFE_INTEGER))) return false;
  return !field.positiveSum || values.reduce((a, b) => a + b, 0) > 0;
}
export function effectiveConfig(base: AppConfig, overrides?: Record<string, AssumptionValue>): AppConfig {
  if (!overrides || !Object.keys(overrides).length) return base;
  const config = structuredClone(base);
  for (const field of ASSUMPTION_FIELDS) {
    const value = overrides[field.path];
    if (!isValidAssumption(field, value, configValue(base, field.path))) continue;
    const parts = field.path.split('.');
    const parent = parts.slice(0, -1).reduce((object: any, key) => object[key], config);
    parent[parts.at(-1)!] = Array.isArray(value) ? [...value] : value;
  }
  return config;
}
