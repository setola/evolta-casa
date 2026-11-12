import type { CurrentHome, HouseholdEstimateAnswers, Project } from '../types';

export const HOUSEHOLD_ESTIMATE_FLAG = 'Consumo elettrico stimato dalle abitudini domestiche';

// Coefficienti orientativi, non misure: clima, efficienza e ore d'uso possono
// cambiare sensibilmente il risultato. Esclude veicoli e dotazioni future.
export function estimateHouseholdElectricity(answers: HouseholdEstimateAnswers) {
  if (!Number.isInteger(answers.occupants) || answers.occupants < 1 || answers.occupants > 20
    || !Number.isFinite(answers.floorAreaM2) || answers.floorAreaM2 < 10 || answers.floorAreaM2 > 1000) {
    throw new Error('Inserisci da 1 a 20 persone e una superficie tra 10 e 1.000 m².');
  }
  const people = answers.occupants;
  const items = [
    { label: 'Consumi di base', kwh: 1000 + people * 350 },
    { label: 'Lavastoviglie', kwh: answers.dishwasher ? 100 + people * 50 : 0 },
    { label: 'Asciugatrice', kwh: answers.dryer ? people * 100 : 0 },
    { label: 'Climatizzazione estiva', kwh: answers.cooling ? answers.floorAreaM2 * 5 : 0 },
    { label: 'Acqua calda elettrica', kwh: answers.electricHotWater ? people * 520 : 0 },
    { label: 'Piano a induzione', kwh: answers.induction ? people * 150 : 0 },
    { label: 'Riscaldamento elettrico', kwh: answers.floorAreaM2 * (answers.heating === 'heatPump' ? 30 : answers.heating === 'resistance' ? 90 : 0) },
  ];
  return { items: items.filter(item => item.kwh > 0), annualKwh: Math.round(items.reduce((total, item) => total + item.kwh, 0) / 50) * 50 };
}

export function initialEstimateAnswers(home: CurrentHome): HouseholdEstimateAnswers {
  return home.electricityInput.estimateAnswers ?? {
    occupants: home.occupants,
    floorAreaM2: home.floorAreaM2,
    occupancyProfile: home.occupancyProfile,
    dishwasher: false,
    dryer: false,
    cooling: home.cooling,
    electricHotWater: home.hotWater === 'electric',
    induction: home.cooking === 'induction',
    heating: home.heating.source === 'electric' ? 'heatPump' : home.heating.source,
  };
}

export function applyHouseholdEstimate(project: Project, answers: HouseholdEstimateAnswers): Project {
  const { annualKwh } = estimateHouseholdElectricity(answers);
  return {
    ...project,
    results: undefined,
    currentHome: {
      ...project.currentHome,
      occupants: answers.occupants,
      floorAreaM2: answers.floorAreaM2,
      occupancyProfile: answers.occupancyProfile,
      cooling: answers.cooling,
      hotWater: answers.electricHotWater ? 'electric' : 'gas',
      cooking: answers.induction ? 'induction' : 'gas',
      heating: { ...project.currentHome.heating, source: answers.heating === 'heatPump' || answers.heating === 'resistance' ? 'electric' : answers.heating },
      electricityInput: {
        mode: 'annual', annualKwh, estimateAnswers: { ...answers },
        qualityFlags: [HOUSEHOLD_ESTIMATE_FLAG],
      },
    },
  };
}
