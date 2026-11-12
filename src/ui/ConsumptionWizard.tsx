import { useEffect, useRef, useState } from 'react';
import type { HouseholdEstimateAnswers, Project } from '../types';
import { applyHouseholdEstimate, estimateHouseholdElectricity, initialEstimateAnswers } from '../engines/householdEstimate';
import './ConsumptionWizard.css';

const appliances = [
  ['dishwasher', 'Lavastoviglie', 'Per il lavaggio abituale delle stoviglie'],
  ['dryer', 'Asciugatrice', 'Per asciugare il bucato durante l’anno'],
  ['cooling', 'Condizionatore', 'Usato per raffrescare in estate'],
  ['electricHotWater', 'Acqua calda elettrica', 'Boiler elettrico tradizionale'],
  ['induction', 'Piano a induzione', 'Per cucinare tutti i giorni'],
] as const;

export function ConsumptionWizard({ project, update, onManual, onBack, onContinue }: {
  project: Project;
  update: (change: (project: Project) => Project) => void;
  onManual: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(() => initialEstimateAnswers(project.currentHome));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step]);
  function answer<K extends keyof HouseholdEstimateAnswers>(key: K, value: HouseholdEstimateAnswers[K]) {
    setAnswers(previous => ({ ...previous, [key]: value }));
  }
  const valid = Number.isInteger(answers.occupants) && answers.occupants >= 1 && answers.occupants <= 20
    && Number.isFinite(answers.floorAreaM2) && answers.floorAreaM2 >= 10 && answers.floorAreaM2 <= 1000;
  const estimate = valid ? estimateHouseholdElectricity(answers) : null;
  const titles = ['Parlaci della tua casa', 'Cosa usi già in casa?', 'Ecco la tua stima di consumo'];
  return (
    <div className="consumption-wizard">
      <div className="consumption-intro">
        <span className="consumption-eyebrow">Non serve avere una bolletta</span>
        <h1>Consumi attuali</h1>
        <p>Quanto consuma la tua casa? Scopriamolo insieme con poche semplici domande.</p>
        <button type="button" className="consumption-text-button" onClick={onManual}>Ho già i consumi: li inserisco io →</button>
      </div>
      <div className="consumption-card">
        <ol className="consumption-progress" aria-label="Passaggi della stima">
          {['La tua casa', 'Le tue abitudini', 'La tua stima'].map((label, index) => (
            <li key={label} aria-current={step === index ? 'step' : undefined} className={step >= index ? 'active' : ''}>
              <span>{index + 1}</span>{label}
            </li>
          ))}
        </ol>
        <h2 ref={heading} tabIndex={-1}>{titles[step]}</h2>
        {step === 0 && <>
          <p>Considera le persone e gli spazi della tua abitazione attuale.</p>
          <div className="consumption-fields">
            <label>Quante persone vivono in casa?
              <input type="number" min={1} max={20} step={1} value={answers.occupants || ''} onChange={event => answer('occupants', Number(event.target.value))} aria-describedby={!valid ? 'estimate-validation' : undefined} />
            </label>
            <label>Quanto è grande la casa? (m²)
              <input type="number" min={10} max={1000} value={answers.floorAreaM2 || ''} onChange={event => answer('floorAreaM2', Number(event.target.value))} aria-describedby={!valid ? 'estimate-validation' : undefined} />
            </label>
            <label>Quando siete più spesso a casa?
              <select value={answers.occupancyProfile} onChange={event => answer('occupancyProfile', event.target.value as HouseholdEstimateAnswers['occupancyProfile'])}>
                <option value="morning">Soprattutto al mattino</option>
                <option value="day">Durante il giorno</option>
                <option value="evening">Soprattutto la sera</option>
                <option value="always">Quasi sempre</option>
              </select>
              <small>Serve a distribuire i consumi nelle ore della giornata, non cambia il totale annuo.</small>
            </label>
          </div>
          {!valid && <p id="estimate-validation" role="alert">Inserisci da 1 a 20 persone e una superficie tra 10 e 1.000 m².</p>}
        </>}
        {step === 1 && <>
          <p>Seleziona solo le dotazioni che usi oggi. Quelle future le aggiungeremo nel prossimo passaggio.</p>
          <p className="consumption-note">Frigorifero, lavatrice, luci, TV e piccoli elettrodomestici sono già inclusi nei consumi di base.</p>
          <fieldset className="consumption-appliances">
            <legend>Quali di queste dotazioni utilizzi?</legend>
            {appliances.map(([key, label, description]) => <label key={key} className={answers[key] ? 'selected' : ''}>
              <input type="checkbox" checked={answers[key]} onChange={event => answer(key, event.target.checked)} />
              <span><strong>{label}</strong><small>{description}</small></span>
            </label>)}
          </fieldset>
          <label className="consumption-heating">Come riscaldi la casa oggi?
            <select value={answers.heating} onChange={event => answer('heating', event.target.value as HouseholdEstimateAnswers['heating'])}>
              <option value="gas">Caldaia a gas</option>
              <option value="heatPump">Pompa di calore elettrica</option>
              <option value="resistance">Stufe o radiatori elettrici</option>
              <option value="none">Altro / nessun riscaldamento elettrico</option>
            </select>
          </label>
        </>}
        {step === 2 && estimate && <>
          <div className="consumption-result">
            <span>Consumo elettrico annuo stimato</span>
            <strong>{estimate.annualKwh.toLocaleString('it-IT')} <small>kWh/anno</small></strong>
            <span>Circa {Math.round(estimate.annualKwh / 12).toLocaleString('it-IT')} kWh al mese</span>
          </div>
          <details className="consumption-breakdown">
            <summary>Come abbiamo calcolato la stima</summary>
            <ul>{estimate.items.map(item => <li key={item.label}><span>{item.label}</span><strong>{item.kwh.toLocaleString('it-IT')} kWh</strong></li>)}</ul>
            <p>Base: 1.000 kWh + 350 per persona. Dotazioni e riscaldamento aggiungono consumi standard in base a persone e superficie. Totale arrotondato a 50 kWh.</p>
          </details>
          <p className="consumption-note">È una stima orientativa, non una lettura della bolletta: clima, efficienza e frequenza d’uso possono cambiare molto il risultato. Non include ricarica auto né dotazioni future. Il metano va inserito separatamente.</p>
          <p>Conferma la stima per passare direttamente alla tua casa futura. Per correggere le risposte, torna indietro.</p>
        </>}
        <div className="consumption-wizard-actions">
          <button type="button" title={step === 0 ? 'Torna al tetto' : undefined} onClick={() => step === 0 ? onBack() : setStep(step - 1)}>Indietro</button>
          {step < 2 ? <button type="button" className="yellow" disabled={!valid} onClick={() => setStep(step + 1)}>{step === 0 ? 'Continua' : 'Mostra la stima'} →</button>
            : <button type="button" className="yellow" disabled={!estimate} onClick={() => { update(p => applyHouseholdEstimate(p, answers)); onContinue(); }}>Usa questa stima →</button>}
        </div>
      </div>
    </div>
  );
}
