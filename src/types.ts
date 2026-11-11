export type PitchPreset = 'flat' | 'low' | 'normal' | 'steep';
export type ConsumptionMode = 'annual' | 'monthly' | 'hourly';
export type OccupancyProfile = 'morning' | 'day' | 'evening' | 'always';
export type ScenarioObjective = 'minBill' | 'maxSelfConsumption' | 'maxROI';
export type ConfidenceLevel = 'Alta' | 'Buona' | 'Indicativa';

export interface Point { x: number; y: number }
export interface GeoPoint { lat: number; lng: number }
export interface Location { address: string; latitude: number; longitude: number; municipality?: string; province?: string; region?: string; timezone: string; solarDatasetRef: string }
export interface PanelPlacement { id: string; roofPlaneId: string; position: Point; rotationDeg: number; validGeometry: boolean; manuallyPlaced: boolean }
export interface RoofObstacle { id: string; label: string; polygon: Point[]; mapPolygon: GeoPoint[] }
export interface RoofSlopeLine { id: string; label: string; points: [GeoPoint, GeoPoint] }
export interface RoofPlane { id: string; label: string; polygon: Point[]; mapPolygon?: GeoPoint[]; obstacles?: RoofObstacle[]; slopeLines?: RoofSlopeLine[]; areaM2: number; azimuthDeg: number; pitchPreset: PitchPreset; pitchDeg: number; usable: boolean; layoutOrientation: 'portrait' | 'landscape'; panels: PanelPlacement[] }
export interface Roof { detectionMethod: 'manual' | 'assisted' | 'fixture'; confirmedByUser: boolean; planes: RoofPlane[]; manualCapacityOverride?: number; mapMagnification?: 1 | 2 | 4 }
export interface ElectricityInput { mode: ConsumptionMode; annualKwh?: number; monthlyKwh?: number[]; hourlyKwh?: number[]; csvImportMetadata?: Record<string, unknown>; qualityFlags: string[] }
export interface Heating { source: 'gas' | 'electric' | 'none'; gasSmcYear?: number; gasInputMode: 'smc' | 'expense' | 'none'; gasExpenseYear?: number; estimatedFromExpense: boolean }
export interface CurrentHome { floorAreaM2: number; occupants: number; occupancyProfile: OccupancyProfile; meterPowerKw?: number; electricityInput: ElectricityInput; heating: Heating; hotWater: 'gas' | 'electric'; cooking: 'gas' | 'induction'; cooling: boolean }
export interface FutureHome { heatPumpEnabled: boolean; electricHotWaterEnabled: boolean; inductionEnabled: boolean; gasRemoved: boolean; estimatedHourlyLoads?: number[] }
export interface Vehicle { kind: 'petrol' | 'diesel' | 'gpl' | 'electric'; kmYear: number; consumption: number; price: number }
export interface FutureEv { kmYear: number; consumptionKwh100km: number; homeChargingShare: number }
export interface Mobility { evEnabled: boolean; currentVehicle: Vehicle; futureEv: FutureEv; chargingProfile: 'night' | 'random' | 'solar'; smartChargingEnabled: boolean }
export interface Tariffs { gridPurchaseEurKwh: number; exportEurKwh: number; gasEurSmc: number; fuelEurLiter: number; pvCostOverride?: number; batteryCostOverride?: number }
export interface SimulationSettings { preferredObjective: ScenarioObjective; allowSyntheticSolar: boolean }
export interface HourlyFlow { pv: number; load: number; batteryCharge: number; batteryDischarge: number; gridImport: number; gridExport: number; batteryLoss: number; soc: number }
export interface AnnualMetrics { pvKwh: number; loadKwh: number; directSelfKwh: number; batteryThroughputKwh: number; gridImportKwh: number; gridExportKwh: number; selfConsumptionPct: number; selfSufficiencyPct: number }
export interface Economics { baselineCost: number; scenarioCost: number; exportRevenue: number; savings: number; investment: number; paybackYears: number | null; mobilityBefore?: number; mobilityAfter?: number }
export interface ScenarioResult { objective: ScenarioObjective; pvConfiguration: { kwp: number; panelCount: number; planes: string[] }; batteryConfiguration: { capacityKwh: number }; hourlyFlows: HourlyFlow[]; monthlyAggregates: Array<{ month: number; pv: number; load: number; import: number; export: number }>; annualMetrics: AnnualMetrics; economics: Economics; explanationTokens: string[]; warnings: string[]; confidence: ConfidenceLevel; score: number }
export interface Project { id: string; schemaVersion: number; name: string; createdAt: string; updatedAt: string; locale: 'it'; sourceSeoPage?: string; assumptionsVersion: string; location?: Location; roof: Roof; currentHome: CurrentHome; futureHome: FutureHome; mobility: Mobility; tariffs: Tariffs; simulationSettings: SimulationSettings; results?: ScenarioResult[] }
export interface AppConfig { market: { country: string; currency: string; locale: string; assumptionsVersion: string }; providers: Record<string, unknown>; map: Record<string, unknown>; solar: any; roof: any; pv: any; battery: any; consumptionProfiles: any; electrification: any; ev: any; energyPrices: any; costModels: any; optimizer: any; confidence: any; persistence: any; seoPages: SeoPage[]; featureFlags: any; legal: any }
export interface SeoPage { slug: string; locale: 'it'; enabled: boolean; seoTitle: string; metaDescription: string; h1: string; intro: string; preset?: Record<string, unknown>; contentSlots?: Record<string, string>; faq?: Array<{ question: string; answer: string }> }
