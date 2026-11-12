import { useState } from 'react';
import type { ReactNode } from 'react';
import type { AppConfig, Project } from '../types';
import { ASSUMPTION_FIELDS, ASSUMPTION_GROUPS, configValue, isValidAssumption } from '../assumptions';
import type { AssumptionValue } from '../assumptions';
import './TariffsPage.css';

type PriceField = { key: keyof Project['tariffs']; label: string; unit: string; description: string; optional?: boolean };
const prices: PriceField[] = [
  { key: 'gridPurchaseEurKwh', label: 'Energia acquistata', unit: '€/kWh', description: 'Valorizza i prelievi dalla rete e il costo elettrico prima e dopo l’impianto.' },
  { key: 'exportEurKwh', label: 'Energia immessa in rete', unit: '€/kWh', description: 'Stima i ricavi dell’energia prodotta e non consumata né accumulata.' },
  { key: 'gasEurSmc', label: 'Metano', unit: '€/Smc', description: 'Valorizza il gas consumato dalla casa prima e dopo l’elettrificazione.' },
  { key: 'pvCostOverride', label: 'Costo totale fotovoltaico manuale', unit: '€', description: 'Sostituisce la formula di investimento FV. Lascia vuoto per usare quota fissa + kWp × quota variabile.', optional: true },
  { key: 'batteryCostOverride', label: 'Costo totale batteria manuale', unit: '€', description: 'Sostituisce la formula del costo accumulo, solo negli scenari con batteria. Vuoto = formula automatica.', optional: true },
];
const display = (value: unknown): string => Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? value ? 'Sì' : 'No' : value === undefined ? 'Non impostato' : String(value);
const yes = (value: boolean) => value ? 'Sì' : 'No';

function Table({ children, caption }: { children: ReactNode; caption: string }) {
  return <div className="assumptions-table-scroll"><table className="assumptions-table">
    <caption>{caption}</caption>
    <thead><tr><th scope="col">Dato</th><th scope="col">Valore e unità</th><th scope="col">A cosa serve</th></tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}
function ReferenceRows({ rows }: { rows: Array<[string, string, string]> }) {
  return <>{rows.map(([label, value, description]) => <tr key={label}><th scope="row">{label}</th><td className="assumptions-reference-value">{value}</td><td>{description}</td></tr>)}</>;
}

export function TariffsPage({ project, update, config, baseConfig }: {
  project: Project; update: (change: (project: Project) => Project) => void; config: AppConfig; baseConfig: AppConfig;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries([
    ...ASSUMPTION_FIELDS.map(field => [field.path, JSON.stringify(configValue(config, field.path))]),
    ...prices.map(field => [`tariffs.${field.key}`, project.tariffs[field.key]?.toString() ?? '']),
    ['vehiclePrice', String(project.mobility.currentVehicle.price)],
  ]));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  function change(key: string, value: string) { setDraft(previous => ({ ...previous, [key]: value })); setMessage(''); }
  function apply(event: React.FormEvent) {
    event.preventDefault();
    const invalid: Record<string, string> = {};
    const overrides: Record<string, AssumptionValue> = {};
    for (const field of ASSUMPTION_FIELDS) {
      let value: unknown;
      try { value = JSON.parse(draft[field.path]); } catch { value = undefined; }
      const base = configValue(baseConfig, field.path);
      if (!isValidAssumption(field, value, base)) {
        invalid[field.path] = `${field.label}: inserisci ${Array.isArray(base) ? `una lista JSON di ${field.length ?? '1–48'} numeri` : 'un numero'} tra ${field.min ?? 0} e ${field.max ?? 'un valore finito'}${field.positiveSum ? ', con somma positiva' : ''}.`;
      } else if (JSON.stringify(value) !== JSON.stringify(base)) overrides[field.path] = value;
    }
    const tariffs = { ...project.tariffs };
    for (const field of prices) {
      const raw = draft[`tariffs.${field.key}`].trim();
      const value = raw === '' && field.optional ? undefined : raw === '' ? NaN : Number(raw);
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) invalid[`tariffs.${field.key}`] = `${field.label}: inserisci un numero non negativo.`;
      else if (value !== undefined) tariffs[field.key] = value;
      else if (field.key === 'pvCostOverride' || field.key === 'batteryCostOverride') delete tariffs[field.key];
    }
    const vehiclePrice = draft.vehiclePrice.trim() === '' ? NaN : Number(draft.vehiclePrice);
    if (!Number.isFinite(vehiclePrice) || vehiclePrice < 0) invalid.vehiclePrice = 'Prezzo del veicolo attuale: inserisci un numero non negativo.';
    setErrors(invalid);
    if (Object.keys(invalid).length) { setMessage(''); return; }
    update(p => ({
      ...p, tariffs: { ...tariffs, fuelEurLiter: p.mobility.currentVehicle.kind === 'electric' ? p.tariffs.fuelEurLiter : vehiclePrice },
      mobility: { ...p.mobility, currentVehicle: { ...p.mobility.currentVehicle, price: vehiclePrice } },
      assumptionOverrides: overrides, results: undefined,
    }));
    setMessage('Modifiche applicate al progetto e alla bozza locale. Ricalcola gli scenari per aggiornare i risultati.');
  }
  function input(key: string, label: string, unit: string, array = false, optional = false) {
    const shared = { id: key, 'aria-label': label, 'aria-invalid': Boolean(errors[key]), 'aria-describedby': errors[key] ? `${key}-error` : undefined, value: draft[key], onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(key, event.target.value) };
    return <>
      {array ? <textarea {...shared} rows={3} spellCheck={false} /> : <input {...shared} type="number" step="any" min={0} placeholder={optional ? 'Automatico' : undefined} />}
      <small className="assumptions-unit">{unit}{array ? ' · lista JSON [valore, valore, …]' : ''}</small>
      {errors[key] && <small className="assumptions-error" id={`${key}-error`}>{errors[key]}</small>}
    </>;
  }
  const e = project.currentHome.electricityInput;
  const annual = e.mode === 'monthly' ? e.monthlyKwh?.reduce((a, b) => a + b, 0) : e.mode === 'hourly' ? e.hourlyKwh?.reduce((a, b) => a + b, 0) : e.annualKwh;
  const vehicle = project.mobility.currentVehicle;
  return <section className="tariffs-page">
    <header><span className="assumptions-eyebrow">Impostazioni esperte · fuori dal percorso guidato</span><h1>Prezzi e assunzioni</h1>
      <p>I dati utilizzati per stimare energia, investimento e risparmio, organizzati per contesto. Versione base: <strong>{baseConfig.market.assumptionsVersion}</strong>.</p>
    </header>
    <aside className="assumptions-warning" role="note"><strong>Modifica questi valori solo se sai quello che stai facendo o sei esperto.</strong><p>Valori non appropriati possono alterare significativamente produzione, dimensionamento e convenienza. Le modifiche valgono solo per questo progetto, non cambiano i valori predefiniti degli altri progetti.</p></aside>
    <p>Tariffe e parametri configurabili restano modificabili. Premi <strong>Applica modifiche</strong>, poi ricalcola gli scenari. Le costanti fisse del modello e i dati provenienti dagli altri passaggi sono indicati separatamente in sola lettura.</p>
    <form onSubmit={apply} noValidate>
      <h2>Tariffe energetiche e costi manuali</h2>
      <Table caption="Prezzi del progetto — modificabili">
        {prices.map(field => <tr key={field.key}><th scope="row"><label htmlFor={`tariffs.${field.key}`}>{field.label}</label></th><td>{input(`tariffs.${field.key}`, field.label, field.unit, false, field.optional)}</td><td>{field.description}</td></tr>)}
        <tr><th scope="row"><label htmlFor="vehiclePrice">Prezzo energia del veicolo attuale</label></th><td>{input('vehiclePrice', 'Prezzo energia del veicolo attuale', vehicle.kind === 'electric' ? '€/kWh' : '€/litro')}</td><td>È il prezzo effettivamente usato per il costo di mobilità attuale: km × consumo / 100 × prezzo. Condiviso con il passaggio Mobilità.</td></tr>
      </Table>
      {ASSUMPTION_GROUPS.map(group => <div className="assumptions-group" key={group.title}>
        <h2>{group.title}</h2><p>{group.description}</p>
        <Table caption={`${group.title} — parametri configurabili`}>
          {group.fields.map(field => <tr key={field.path}><th scope="row"><label htmlFor={field.path}>{field.label}</label><small>{project.assumptionOverrides?.[field.path] !== undefined ? 'Personalizzato nel progetto' : 'Valore del modello'}</small></th>
            <td>{input(field.path, field.label, field.unit, Array.isArray(configValue(config, field.path)))}</td><td>{field.description}</td></tr>)}
        </Table>
      </div>)}
      {Object.keys(errors).length > 0 && <p className="assumptions-error" role="alert">Modifiche non applicate: correggi i {Object.keys(errors).length} valori evidenziati.</p>}
      {message && <p role="status">{message}</p>}
      <div className="assumptions-apply"><button className="yellow" type="submit">Applica modifiche</button><button type="button" onClick={() => {
        setDraft(previous => ({ ...previous, ...Object.fromEntries(ASSUMPTION_FIELDS.map(field => [field.path, JSON.stringify(configValue(baseConfig, field.path))])) }));
        setErrors({}); setMessage('Parametri tecnici ripristinati nel modulo. Premi Applica modifiche per confermare. Tariffe e costi manuali non sono cambiati.');
      }}>Ripristina parametri tecnici predefiniti</button></div>
    </form>
    <h2>Dati della casa e della mobilità</h2>
    <p>Sola lettura qui: si modificano nei rispettivi passaggi del percorso. I coefficienti sopra si applicano a questi dati.</p>
    <Table caption="Dati del progetto utilizzati dai calcoli">
      <ReferenceRows rows={[
        ['Consumo elettrico attuale', `${display(annual)} kWh/anno · modalità ${e.mode}`, 'Carico di partenza della casa. Le serie mensili/orarie, se presenti, hanno precedenza sul valore annuo.'],
        ['Profilo consumi', display(e.mode === 'monthly' ? e.monthlyKwh : e.mode === 'hourly' ? `${e.hourlyKwh?.length ?? 0} letture orarie; serie completa nell’export JSON` : project.currentHome.occupancyProfile), 'Consumi mensili gennaio–dicembre o distribuzione oraria selezionata.'],
        ['Occupanti e superficie', `${project.currentHome.occupants} persone · ${project.currentHome.floorAreaM2} m²`, 'Usati nella stima guidata; gli occupanti determinano anche acqua calda e induzione future.'],
        ['Metano attuale', `${display(project.currentHome.heating.gasSmcYear)} Smc/anno`, 'Base dei costi gas e della conversione verso pompa di calore. Non stimato dal wizard.'],
        ['Dotazioni attuali', `Riscaldamento: ${project.currentHome.heating.source}; acqua calda: ${project.currentHome.hotWater}; cucina: ${project.currentHome.cooking}; raffrescamento: ${yes(project.currentHome.cooling)}`, 'Evita di aggiungere una seconda volta carichi già elettrici nella casa futura.'],
        ['Interventi futuri', `Pompa di calore: ${yes(project.futureHome.heatPumpEnabled)}; acqua calda elettrica: ${yes(project.futureHome.electricHotWaterEnabled)}; induzione: ${yes(project.futureHome.inductionEnabled)}; eliminazione gas: ${yes(project.futureHome.gasRemoved)}`, 'Attiva i carichi aggiuntivi e determina se resta una spesa di gas.'],
        ['Tetto disponibile', `${project.roof.planes.length} falde · ${project.roof.planes.filter(plane => plane.usable).reduce((sum, plane) => sum + plane.panels.length, 0)} pannelli · capacità forzata: ${display(project.roof.manualCapacityOverride)}`, 'La geometria e gli ostacoli limitano i pannelli. La capacità forzata, se impostata, ha precedenza sul conteggio.'],
        ...project.roof.planes.map(plane => [plane.label, `${plane.areaM2.toFixed(1)} m² · azimut ${plane.azimuthDeg}° · pendenza ${plane.pitchDeg}° · utilizzabile ${yes(plane.usable)}`, 'Perimetro e ostacoli nel passaggio Tetto; orientamento e pendenza correggono la resa solare.'] as [string, string, string]),
        ['Veicolo attuale', `${vehicle.kind} · ${vehicle.kmYear} km/anno · ${vehicle.consumption} ${vehicle.kind === 'electric' ? 'kWh' : 'litri'}/100 km`, 'Calcola la spesa di mobilità prima dell’intervento.'],
        ['Auto elettrica futura', `${yes(project.mobility.evEnabled)} · ${project.mobility.futureEv.kmYear} km/anno · ${project.mobility.futureEv.consumptionKwh100km} kWh/100 km · quota a casa ${project.mobility.futureEv.homeChargingShare}`, 'Stima l’energia da ricaricare a casa: km × consumo / 100 × quota domestica.'],
        ['Profilo di ricarica', project.mobility.chargingProfile, 'Seleziona uno dei profili orari di ricarica riportati sopra.'],
      ]} />
    </Table>
    <FixedModelReference />
    <p className="assumptions-legal">{config.legal.disclaimer} Ombre locali, incentivi, degrado e inflazione non sono modellati. I dati sintetici non sostituiscono bollette o preventivi.</p>
  </section>;
}

function FixedModelReference() {
  const groups: Array<{ title: string; rows: Array<[string, string, string]> }> = [
    { title: 'Stima guidata: coefficienti fissi', rows: [
      ['Base domestica', '1.000 + 350 × persone kWh/anno', 'Include frigorifero, lavatrice, luci, TV e piccoli apparecchi.'],
      ['Lavastoviglie e asciugatrice', 'Lavastoviglie: 100 + 50 × persone; asciugatrice: 100 × persone kWh/anno', 'Aggiunti solo se selezionati nel wizard.'],
      ['Raffrescamento', '5 × superficie m² kWh/anno', 'Stima standard del climatizzatore estivo.'],
      ['Acqua calda e induzione attuali', '520 e 150 kWh/persona/anno', 'Consumi delle dotazioni attuali, distinti dai coefficienti modificabili della casa futura.'],
      ['Riscaldamento elettrico attuale', 'Pompa di calore: 30; resistenze: 90 kWh/m²/anno', 'Aggiunto se selezionato nel wizard. Non usa clima o classe energetica.'],
      ['Arrotondamento', '50 kWh', 'Il totale della stima domestica è arrotondato al multiplo più vicino. Cambiare coefficienti tecnici non rigenera una stima domestica già confermata.'],
    ] },
    { title: 'Distribuzioni fisse di riscaldamento e usi domestici', rows: [
      ['Riscaldamento: pesi mensili', '0.2, 0.18, 0.14, 0.08, 0.03, 0, 0, 0, 0.03, 0.08, 0.12, 0.14', 'Gennaio–dicembre; normalizzati per ripartire il fabbisogno annuo della pompa di calore.'],
      ['Riscaldamento: pesi orari', '0.055, 0.055, 0.055, 0.055, 0.055, 0.05, 0.045, 0.035, 0.03, 0.025, 0.02, 0.02, 0.02, 0.02, 0.025, 0.03, 0.04, 0.045, 0.05, 0.055, 0.06, 0.06, 0.06, 0.06', 'Ore 00–23; normalizzati per distribuire il riscaldamento durante il giorno.'],
      ['Acqua calda: pesi orari', '0.015, 0.01, 0.008, 0.008, 0.01, 0.025, 0.07, 0.075, 0.05, 0.035, 0.03, 0.035, 0.045, 0.04, 0.035, 0.04, 0.05, 0.065, 0.075, 0.08, 0.075, 0.055, 0.035, 0.024', 'Ore 00–23; distribuzione fissa normalizzata del consumo aggiuntivo per acqua calda.'],
      ['Induzione: pesi orari', '0, 0, 0, 0, 0, 0, 0.04, 0.06, 0.03, 0, 0.02, 0.1, 0.13, 0.02, 0, 0, 0.03, 0.12, 0.2, 0.16, 0.08, 0.02, 0, 0', 'Ore 00–23; distribuzione normalizzata del consumo aggiuntivo per cucinare.'],
    ] },
    { title: 'Altre assunzioni e limiti del modello attuale', rows: [
      ['Calendario', '365 giorni · 8.760 ore', 'Anno non bisestile; i mesi usano i rispettivi giorni di calendario.'],
      ['Ore di luce mensili', '8, 9, 11, 13, 14, 15, 15, 14, 12, 10, 9, 8', 'Gennaio–dicembre. Una curva sinusoidale centrata a mezzogiorno distribuisce la produzione nelle ore.'],
      ['Riferimenti della resa solare', 'Sud: 180°; fattore geometrico minimo: 0,55; PR di riferimento: 0,82', 'Il fattore orientamento/pendenza è limitato inferiormente; la resa viene moltiplicata per PR / 0,82. In assenza di falde si usano sud e 30°.'],
      ['Costo mobilità EV futura', '0,30 €/kWh (fisso)', 'Il modello corrente usa questo prezzo, non la tariffa di acquisto, per la voce mobilità futura. La ricarica domestica è presente anche nel carico elettrico: possibile sovrapposizione dei costi, da considerare nel leggere il risparmio.'],
      ['Punteggio raccomandazione', 'risparmio/1.000 − payback/10 − investimento/50.000 + (100 − autosufficienza%)/1.000', 'Sceglie lo scenario raccomandato fra i tre risultati; payback assente = 25 anni. I pesi recommendationWeights nello YAML non sono applicati.'],
      ['Confidenza dei consumi', 'Annui: Indicativa; mensili: Buona; orari: Alta', 'Classificazione attuale basata sulla modalità di input, non una garanzia di precisione della previsione.'],
      ['Ricarica intelligente', 'Nessuna ottimizzazione aggiuntiva', 'Il carico segue il profilo di ricarica selezionato. Il comando smart non aggiunge ancora uno spostamento dinamico.'],
      ['Campi configurati ma non usati nei calcoli', 'Efficienza nominale del pannello, costModels, confidence.reductions, recommendationWeights', 'Non sono presentati come leve modificabili perché non cambiano la simulazione attuale. I prezzi e i default EV dello YAML inizializzano nuovi progetti: qui sono mostrati i valori effettivi del progetto.'],
    ] },
  ];
  return <><h2>Costanti del modello · sola lettura</h2><p>Questi valori sono fissati nel motore e non sono modificabili da questa pagina. Sono riportati per rendere esplicite anche le ipotesi non configurabili.</p>
    {groups.map(group => <Table caption={group.title} key={group.title}><ReferenceRows rows={group.rows} /></Table>)}
  </>;
}
