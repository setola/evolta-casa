import { ChevronDown, Download, Minus, Play, Plus, Save, Upload } from "lucide-react";
import { RoofMapViewport } from "./RoofMapViewport";
import { ConsumptionWizard } from "./ConsumptionWizard";
import { TariffsPage } from "./TariffsPage";
import { effectiveConfig } from "../assumptions";
import { appPath, publicPath } from "../paths";
import { HOUSEHOLD_ESTIMATE_FLAG } from "../engines/householdEstimate";
import { MapZoomControls } from "./MapZoomControls";
import { RoofSubdivisions } from "./RoofSubdivisions";
import { RoofPreviewSummary } from "./RoofPreviewSummary";
import { assignRoofColors, nextRoofColor, roofColor, roofPlaneStyle } from "./roofColors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  AppConfig,
  Project,
  RoofPlane,
  RoofSlopeLine,
  ScenarioResult,
  SeoPage,
} from "../types";
import {
  autoLayoutPlane,
  panelFootprint,
  updatePlaneArea,
} from "../engines/roof";
import { runSimulation } from "../engines/optimizer";
import { hourlyFromElectricityInput } from "../engines/consumption";
import { futureHomeExtraLoads, evHomeLoad } from "../engines/electrification";
import { newId } from "../id";
import { applyPreset, createProject } from "../project";
import {
  clearAll,
  deleteProject,
  exportProject,
  importProject,
  listProjects,
  loadDraftProject,
  saveDraftProject,
  saveProject,
} from "../persistence";

const steps = [
  "Home",
  "Trova casa",
  "Tetto",
  "Consumi",
  "Casa futura",
  "Mobilità",
  "Prezzi",
  "Risultati",
];
const stepRoutes = [
  "/",
  "/trova-casa",
  "/tetto",
  "/consumi",
  "/casa-futura",
  "/mobilita",
  "/prezzi",
  "/risultati",
];
const MAX_SATELLITE_ZOOM_FALLBACK = 23;

function googleMapControlOptions(google: any) {
  return {
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: true,
    zoomControlOptions: {
      position: google.maps.ControlPosition.RIGHT_CENTER,
    },
    scaleControl: false,
    rotateControl: false,
    panControl: false,
    clickableIcons: false,
  };
}

function zoomMapToMaximum(
  google: any,
  map: any,
  position: { lat: number; lng: number },
) {
  const MaxZoomService = google?.maps?.MaxZoomService;
  if (!MaxZoomService) {
    map.setZoom(MAX_SATELLITE_ZOOM_FALLBACK);
    return;
  }
  new MaxZoomService().getMaxZoomAtLatLng(
    position,
    (result: { status?: string; zoom?: number } | null) => {
      map.setZoom(
        result?.status === "OK" && typeof result.zoom === "number"
          ? result.zoom
          : MAX_SATELLITE_ZOOM_FALLBACK,
      );
    },
  );
}
function pathToStep(pathname: string) {
  const normalized = appPath(pathname);
  if (normalized === "/pannelli") return 2;
  const index = stepRoutes.indexOf(normalized);
  return index >= 0 ? index : 0;
}

type UpdateProject = (m: (p: Project) => Project) => void;
type HomeStart = {
  address: string;
  location?: Project["location"];
};
type StepProps = {
  project: Project;
  update: UpdateProject;
  config?: AppConfig;
};

type GoogleMapsAutocompleteListener = { remove: () => void };
type GoogleMapsPlaceResult = { formatted_address?: string; name?: string };
type GoogleMapsAutocomplete = {
  addListener: (
    eventName: "place_changed",
    handler: () => void,
  ) => GoogleMapsAutocompleteListener;
  getPlace: () => GoogleMapsPlaceResult;
};
type GoogleMapsNamespace = {
  maps?: {
    places?: {
      Autocomplete: new (
        input: HTMLInputElement,
        options: {
          componentRestrictions?: { country: string | string[] };
          fields?: string[];
          types?: string[];
        },
      ) => GoogleMapsAutocomplete;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleMapsNamespace;
    __googleMapsPlacesPromise?: Promise<void>;
    __initGoogleMapsPlaces?: () => void;
  }
}

export function App({ config: baseConfig }: { config: AppConfig }) {
  const seo = baseConfig.seoPages.find(
    (p) => p.slug === appPath(window.location.pathname) && p.enabled,
  );
  const [project, setProject] = useState<Project>(
    () =>
      loadDraftProject() ??
      applyPreset(createProject(baseConfig, seo?.slug), seo?.preset),
  );
  // update() clones the project: memoize by values to keep RoofStep's layout effect stable.
  const overridesKey = JSON.stringify(project.assumptionOverrides ?? {});
  const config = useMemo(() => effectiveConfig(baseConfig, JSON.parse(overridesKey)), [baseConfig, overridesKey]);
  const [step, setStep] = useState(() => pathToStep(window.location.pathname));
  const [saved, setSaved] = useState<Project[]>([]);
  const [message, setMessage] = useState("");
  const [pendingAddress, setPendingAddress] = useState(
    project.location?.address ?? "",
  );
  const [headerAddress, setHeaderAddress] = useState(
    project.location?.address ?? "",
  );
  const results = useMemo(() => project.results ?? [], [project.results]);

  useEffect(() => {
    listProjects()
      .then(setSaved)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    saveDraftProject(project);
  }, [project]);
  useEffect(() => {
    const onPopState = () => {
      const nextStep = pathToStep(window.location.pathname);
      if (appPath(window.location.pathname) === "/pannelli") {
        window.history.replaceState(window.history.state, "", `${publicPath('/tetto')}${window.location.search}${window.location.hash}`);
      }
      setStep(nextStep);
    };
    onPopState();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  function navigateStep(nextStep: number) {
    const safeStep = Math.max(0, Math.min(stepRoutes.length - 1, nextStep));
    const nextPath = publicPath(stepRoutes[safeStep]);
    if (window.location.pathname !== nextPath)
      window.history.pushState(null, "", nextPath);
    setStep(safeStep);
  }
  function update(mutator: (p: Project) => Project) {
    setProject((p) =>
      mutator({ ...structuredClone(p), updatedAt: new Date().toISOString() }),
    );
  }
  async function persist() {
    const p = await saveProject(project);
    setProject(p);
    setSaved(await listProjects());
    setMessage("Progetto salvato localmente.");
  }
  function simulate() {
    update((p) => {
      const current = { ...p, roof: { ...p.roof, planes: p.roof.planes.map((plane) => autoLayoutPlane(plane, config)) } };
      return { ...current, results: runSimulation(current, config) };
    });
    navigateStep(7);
  }

  return (
    <div>
      <Header
        step={step}
        setStep={navigateStep}
        project={project}
        addressLabel={headerAddress}
      />
      <main
        className={
          step === 0 || step === 1 || step === 2 || step === 4
            ? "mock-main"
            : ""
        }
      >
        {step === 0 && (
          <HomeStep
            seo={seo}
            saved={saved}
            initialAddress={project.location?.address ?? ""}
            onStart={({ address, location }) => {
              setPendingAddress(address);
              setHeaderAddress(address || location?.address || "");
              if (location) setProject((p) => ({ ...p, location }));
              navigateStep(1);
            }}
            onLoad={(p: Project) => {
              setProject(p);
              setHeaderAddress(p.location?.address ?? "");
              navigateStep(7);
            }}
            config={config}
          />
        )}
        {step === 1 && (
          <LocationStep
            project={project}
            update={update}
            initialAddress={pendingAddress}
            onConfirm={() => navigateStep(2)}
            config={config}
          />
        )}
        {step === 2 && (
          <RoofStep
            project={project}
            update={update}
            config={config}
            onConfirm={() => navigateStep(3)}
          />
        )}
        {step === 3 && <ConsumptionStep project={project} update={update} onBack={() => navigateStep(2)} onContinue={() => navigateStep(4)} onSave={persist} />}
        {step === 4 && <FutureStep project={project} update={update} config={config} />}
        {step === 5 && <MobilityStep project={project} update={update} />}
        {step === 6 && (
          <TariffsPage key={project.id} project={project} update={update} config={config} baseConfig={baseConfig} />
        )}
        {step === 7 && (
          <ResultsStep
            project={project}
            update={update}
            results={results}
            config={config}
            simulate={simulate}
          />
        )}
        {step !== 0 && step !== 1 && step !== 2 && step !== 3 && step !== 4 && (
          <div className="actions">
            <button
              type="button"
              disabled={step === 0}
              onClick={() => navigateStep(step === 7 || step === 6 ? 5 : Math.max(0, step - 1))}
            >
              Indietro
            </button>
            <button type="button" onClick={persist}>
              <Save size={16} /> Salva
            </button>
            <button type="button" onClick={simulate}>
              <Play size={16} /> Calcola scenari
            </button>
            <button
              type="button"
              disabled={step >= stepRoutes.length - 1}
              onClick={() => step === 5 ? simulate() : navigateStep(step + 1)}
            >
              Avanti
            </button>
          </div>
        )}
        {message && <p className="toast">{message}</p>}
      </main>
      <footer className="settings-footer">
        <a href={publicPath('/prezzi')} onClick={(event) => { event.preventDefault(); navigateStep(6); }}>Prezzi e assunzioni · impostazioni esperte</a>
      </footer>
    </div>
  );
}

function Header({
  step,
  setStep,
  project,
  addressLabel,
}: {
  step: number;
  setStep: (s: number) => void;
  project: Project;
  addressLabel: string;
}) {
  const isHome = step === 0;
  return (
    <header className={`cw-header ${isHome ? "home-header" : ""}`}>
      <a
        className="cw-brand"
        href={publicPath('/')}
        onClick={(e) => {
          e.preventDefault();
          setStep(0);
        }}
      >
        <img className="cw-logo" src={publicPath('/ui/logo.svg')} alt="" />
        <div>
          <strong>CasaWatt</strong>
          <span>Più valore alla tua energia</span>
        </div>
      </a>
      {isHome ? (
        <nav className="cw-tabs home-nav">
          <a href="#come-funziona">Come funziona</a>
          <a href="#possibilita">Cosa puoi scoprire</a>
          <a href="#affidabilita">Affidabilità</a>
        </nav>
      ) : (
        <nav className="cw-stepper" aria-label="Step di configurazione">
          {steps.slice(1, 6).map((s, i) => (
            <button
              type="button"
              key={s}
              className={
                step === i + 1 ? "current" : step > i + 1 ? "done" : ""
              }
              onClick={() => setStep(i + 1)}
            >
              <b>{i + 1}</b>
              <span>{s}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="cw-meta">
        <span className="cw-address">
          ⌂ {addressLabel || project.location?.address || "La tua casa"}
        </span>
      </div>
    </header>
  );
}

function useGooglePlacesAutocomplete(
  inputRef: React.RefObject<HTMLInputElement | null>,
  onPlaceSelected: (address: string) => void,
  config?: AppConfig,
) {
  useEffect(() => {
    let cancelled = false;
    let listener: GoogleMapsAutocompleteListener | undefined;

    loadGoogleMapsPlaces(config)
      .then(() => {
        if (cancelled || !inputRef.current) return;
        const Autocomplete = window.google?.maps?.places?.Autocomplete;
        if (!Autocomplete) return;

        const autocomplete = new Autocomplete(inputRef.current, {
          componentRestrictions: { country: "it" },
          fields: ["formatted_address", "name"],
          types: ["address"],
        });
        listener = autocomplete.addListener("place_changed", () => {
          const place = autocomplete.getPlace();
          const selectedAddress = place.formatted_address ?? place.name;
          if (selectedAddress) onPlaceSelected(selectedAddress);
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      listener?.remove();
    };
  }, [config, inputRef, onPlaceSelected]);
}

function AddressSearch({
  initialAddress,
  className,
  submitLabel,
  onSubmit,
  onInvalid,
  onAddressChange,
  config,
  children,
}: {
  initialAddress: string;
  className: string;
  submitLabel: string;
  onSubmit: (address: string) => void;
  onInvalid: (message: string) => void;
  onAddressChange?: (address: string) => void;
  config?: AppConfig;
  children?: ReactNode;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [selectedAddress, setSelectedAddress] = useState(initialAddress);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectFormattedAddress = useCallback(
    (formattedAddress: string) => {
      setAddress(formattedAddress);
      setSelectedAddress(formattedAddress);
      onAddressChange?.(formattedAddress);
      onInvalid("");
    },
    [onAddressChange, onInvalid],
  );
  useGooglePlacesAutocomplete(inputRef, selectFormattedAddress, config);

  function submit() {
    if (!selectedAddress || address !== selectedAddress) {
      onInvalid(
        "Seleziona un indirizzo dall’elenco dei suggerimenti di Google Maps.",
      );
      return;
    }
    onSubmit(selectedAddress);
  }

  return (
    <div className={className}>
      <label>
        <span>⌕</span>
        <input
          ref={inputRef}
          value={address}
          onChange={(event) => {
            const nextAddress = event.target.value;
            setAddress(nextAddress);
            setSelectedAddress("");
            onAddressChange?.(nextAddress);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          aria-label="Indirizzo casa"
          aria-invalid={Boolean(address && address !== selectedAddress)}
          placeholder="Inserisci il tuo indirizzo"
          autoComplete="off"
        />
      </label>
      <button type="button" className="yellow" onClick={submit}>
        {submitLabel}
      </button>
      {children}
    </div>
  );
}

function HomeStep({
  seo,
  saved,
  initialAddress,
  onStart,
  onLoad,
  config,
}: {
  seo?: SeoPage;
  saved: Project[];
  initialAddress: string;
  onStart: (start: HomeStart) => void;
  onLoad: (p: Project) => void;
  config: AppConfig;
}) {
  const [positionStatus, setPositionStatus] = useState("");
  function startWithCurrentPosition() {
    if (!navigator.geolocation) {
      setPositionStatus("Geolocalizzazione non disponibile in questo browser.");
      return;
    }
    if (!window.isSecureContext) {
      setPositionStatus(
        "Il browser consente la posizione solo su HTTPS o localhost. Se accedi da IP:porta, apri il sito in HTTPS oppure inserisci un indirizzo.",
      );
      return;
    }
    setPositionStatus("Richiedo l’autorizzazione al browser...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onStart({
          address: "Posizione GPS",
          location: {
            address: "Posizione GPS",
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            timezone: "Europe/Rome",
            solarDatasetRef: "synthetic-it",
          },
        });
      },
      (error) => {
        setPositionStatus(
          error.code === error.PERMISSION_DENIED
            ? "Permesso GPS negato dal browser: abilita la posizione per questo sito o inserisci un indirizzo."
            : "Non riesco a leggere la posizione: riprova o inserisci un indirizzo.",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  return (
    <section className="home-page">
      <div className="home-hero">
        <div className="home-hero-copy">
          <p className="eyebrow">Il futuro energetico di casa tua</p>
          <h1>
            {seo?.h1 ?? "Scopri quale energia conviene davvero a casa tua"}
          </h1>
          <p>
            {seo?.intro ??
              "CasaWatt parte dai dati reali del tuo tetto e dei tuoi consumi e confronta le soluzioni con fotovoltaico, accumulo, pompa di calore e auto elettrica per trovare quella più adatta a te."}
          </p>
          <AddressSearch
            initialAddress={initialAddress}
            className="home-search"
            submitLabel="Analizza la mia casa →"
            onSubmit={(address) => onStart({ address })}
            onInvalid={setPositionStatus}
            config={config}
          />
          <button
            type="button"
            className="use-position"
            onClick={startWithCurrentPosition}
          >
            ⌖ Usa la mia posizione
          </button>
          {positionStatus && <p className="gps-status">{positionStatus}</p>}
          <div className="home-badges">
            <span>◎ Gratuito</span>
            <span>♙ Nessuna registrazione</span>
            <span>
              ▣ I dati restano
              <br />
              sul tuo dispositivo
            </span>
          </div>
          {saved.length > 0 && (
            <div className="resume-projects">
              <strong>Riprendi un progetto</strong>
              {saved.slice(0, 2).map((p) => (
                <button type="button" key={p.id} onClick={() => onLoad(p)}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="result-example">
          <div>
            <strong>Esempio di risultato</strong>
            <span>ⓘ</span>
          </div>
          <small className="good">✓ Stima buona</small>
          <h2>6,3 kWp · senza accumulo</h2>
          <div className="example-metrics">
            <p>
              ☼{" "}
              <b>
                Risparmio
                <br />
                circa
                <br />
                1.000 €/anno
              </b>
            </p>
            <p>
              ◴{" "}
              <b>
                Rientro
                <br />
                circa
                <br />7 anni
              </b>
            </p>
          </div>
          <small>Basata su dati reali e sul tuo profilo di consumo</small>
        </aside>
      </div>
      <div className="home-content" id="come-funziona">
        <div className="section-head">
          <div>
            <p className="eyebrow green">Come funziona</p>
            <h2>Una risposta semplice a una decisione complessa</h2>
          </div>
          <p>
            In pochi minuti ottieni un’analisi personalizzata e confronti le
            soluzioni più adatte alla tua casa, con dati chiari e indipendenti.
          </p>
        </div>
        <div className="how-grid">
          <Card
            icon="⌖"
            title="1. Trova la tua casa"
            text="Inserisci l’indirizzo: analizziamo il tuo tetto, l’irraggiamento solare e le sue potenzialità."
          />
          <span className="arrow">→</span>
          <Card
            icon="⌂"
            title="2. Raccontaci come consumi"
            text="Indica i tuoi consumi attuali e le tue esigenze: pompa di calore, auto elettrica o altri obiettivi."
          />
          <span className="arrow">→</span>
          <Card
            icon="▥"
            title="3. Confronta tre strategie"
            text="Ricevi una simulazione con tre scenari per scegliere l’equilibrio migliore tra risparmio, indipendenza e investimento."
          />
        </div>
        <div className="section-head" id="possibilita">
          <div>
            <p className="eyebrow green">Le tue possibilità</p>
            <h2>Non una sola stima: tre modi di scegliere</h2>
          </div>
          <p>
            Stessa casa, obiettivi diversi. Confronta i tre scenari e trova
            quello più adatto a te.
          </p>
        </div>
        <div className="scenario-grid">
          <Card
            icon="☀"
            title="Minima bolletta"
            text="Più indipendenza, bolletta quasi zero"
          />
          <Card
            icon="🌿"
            title="Massimo autoconsumo"
            text="Usa di più la tua energia"
          />
          <Card
            icon="▥"
            title="Miglior ROI"
            text="Il miglior equilibrio economico"
          />
        </div>
        <p id="affidabilita" className="legal">
          {config.legal.disclaimer}
        </p>
      </div>
    </section>
  );
}
function Card({
  icon,
  title,
  text,
}: {
  icon?: string;
  title: string;
  text: string;
}) {
  return (
    <article className="card info-card">
      {icon && <span className="card-icon">{icon}</span>}
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function LocationStep({
  project,
  update,
  config,
  initialAddress = "",
  onConfirm,
}: StepProps & { initialAddress?: string; onConfirm: () => void }) {
  const [query, setQuery] = useState(
    initialAddress || project.location?.address || "",
  );
  const initialCenter = project.location ?? {
    latitude: 45.4642,
    longitude: 9.19,
  };
  const [status, setStatus] = useState("Carico Google Maps...");
  const [selectedCoords, setSelectedCoords] = useState(initialCenter);
  const mapCanvasRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<any>(null);
  const didCenterInitialAddressRef = useRef(false);
  const hasGoogleMapsKey = Boolean(googleMapsApiKey(config));

  useEffect(() => {
    const key = googleMapsApiKey(config);
    if (!key) {
      setStatus("Configura VITE_GOOGLE_MAPS_API_KEY e riavvia Vite.");
      return;
    }

    let cancelled = false;
    let idleListener: { remove: () => void } | undefined;
    void loadGoogleMapsScript(key)
      .then((google) => {
        if (cancelled || !mapCanvasRef.current) return;
        const map = new google.maps.Map(mapCanvasRef.current, {
          center: { lat: initialCenter.latitude, lng: initialCenter.longitude },
          zoom: MAX_SATELLITE_ZOOM_FALLBACK,
          mapTypeId: "satellite",
          tilt: 0,
          ...googleMapControlOptions(google),
        });
        mapInstanceRef.current = map;
        zoomMapToMaximum(google, map, {
          lat: initialCenter.latitude,
          lng: initialCenter.longitude,
        });
        idleListener = map.addListener("idle", () => {
          const center = map.getCenter();
          if (!center) return;
          setSelectedCoords({
            latitude: center.lat(),
            longitude: center.lng(),
          });
        });
        if (
          initialAddress.trim() &&
          !project.location &&
          !didCenterInitialAddressRef.current
        ) {
          didCenterInitialAddressRef.current = true;
          void geocode();
        } else {
          setStatus(
            "Sposta la mappa finché il tetto corretto è sotto il pin centrale.",
          );
        }
      })
      .catch(() => {
        setStatus(
          hasGoogleMapsKey
            ? "Google Maps non è disponibile: abilita Maps JavaScript API e controlla le restrizioni della chiave."
            : "Configura VITE_GOOGLE_MAPS_API_KEY e riavvia Vite.",
        );
      });

    return () => {
      cancelled = true;
      idleListener?.remove();
    };
  }, [
    config,
    hasGoogleMapsKey,
    initialCenter.latitude,
    initialCenter.longitude,
  ]);

  function moveMapTo(coords: { latitude: number; longitude: number }) {
    setSelectedCoords(coords);
    mapInstanceRef.current?.setCenter({
      lat: coords.latitude,
      lng: coords.longitude,
    });
    const map = mapInstanceRef.current;
    const google = (window as any).google;
    if (map && google)
      zoomMapToMaximum(google, map, {
        lat: coords.latitude,
        lng: coords.longitude,
      });
  }

  async function geocode(address = query) {
    setStatus("Cerco l’indirizzo...");
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&q=${encodeURIComponent(address)}`,
      );
      if (!r.ok) throw new Error("Provider geocoding non disponibile");
      const j = await r.json();
      const hit = j[0];
      if (!hit) throw new Error("Nessun risultato");
      const nextLocation = {
        address,
        latitude: Number(hit.lat),
        longitude: Number(hit.lon),
        municipality:
          hit.address?.city ?? hit.address?.town ?? hit.address?.village,
        province: hit.address?.county,
        region: hit.address?.state,
        timezone: "Europe/Rome",
        solarDatasetRef: "synthetic-it",
      };
      update((p) => ({ ...p, location: nextLocation }));
      moveMapTo(nextLocation);
      setStatus(
        "Indirizzo trovato. Ora trascina la mappa sotto il pin centrale.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Indirizzo non trovato: puoi usare GPS o spostare la mappa manualmente.",
      );
    }
  }

  function useGps() {
    if (!navigator.geolocation) {
      setStatus("Geolocalizzazione non disponibile in questo browser.");
      return;
    }
    setStatus("Richiedo la posizione al browser...");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const nextLocation = {
          address: "Posizione GPS",
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          timezone: "Europe/Rome",
          solarDatasetRef: "synthetic-it",
        };
        update((p) => ({ ...p, location: nextLocation }));
        moveMapTo(nextLocation);
        setStatus(
          "Posizione GPS acquisita. Sposta la mappa fino al tetto corretto.",
        );
      },
      () =>
        setStatus(
          "Permesso GPS negato: cerca un indirizzo o sposta la mappa manualmente.",
        ),
    );
  }

  function confirmLocation() {
    update((p) => ({
      ...p,
      location: {
        ...(p.location ?? {
          address: query || "Posizione manuale",
          timezone: "Europe/Rome",
          solarDatasetRef: "synthetic-it",
        }),
        latitude: selectedCoords.latitude,
        longitude: selectedCoords.longitude,
        address: p.location?.address || query || "Posizione manuale",
      },
    }));
    onConfirm();
  }

  return (
    <section className="location-page">
      <div className="map-workspace">
        <div className="google-map-shell">
          <div className="google-map-canvas" ref={mapCanvasRef} />
          <div className="fixed-center-pin" aria-hidden="true">
            ⌖
          </div>
          <button
            type="button"
            className="map-confirm-position"
            onClick={confirmLocation}
          >
            Conferma posizione ›
          </button>
          <button
            type="button"
            className="map-scroll-cta"
            onClick={() =>
              document
                .getElementById("location-help")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            Come usare la mappa ↓
          </button>
          {!hasGoogleMapsKey && (
            <div className="map-error">
              <strong>Google Maps non configurato</strong>
              <span>Configura VITE_GOOGLE_MAPS_API_KEY e riavvia Vite.</span>
            </div>
          )}
        </div>
      </div>

      <div className="location-title-band" id="location-help">
        <button type="button" className="back-link dark">
          ‹ Torna alla home
        </button>
        <p className="eyebrow green">Trova casa</p>
        <h1>Centra il tuo tetto sotto il pin</h1>
      </div>

      <div className="location-topbar">
        <p>
          Cerca e seleziona il tuo indirizzo dai suggerimenti di Google Maps.
          Poi trascina la mappa e usa lo zoom: il pin resta fermo, quindi porta
          il tetto esatto al centro. Quando è allineato, premi “Conferma
          posizione” per continuare.
        </p>
        <AddressSearch
          initialAddress={query}
          className="location-search"
          submitLabel="Cerca"
          onAddressChange={setQuery}
          onInvalid={setStatus}
          onSubmit={(address) => void geocode(address)}
          config={config}
        >
          <button type="button" className="outline" onClick={useGps}>
            Usa GPS
          </button>
        </AddressSearch>
      </div>

      <div className="location-confirm-bar">
        <div>
          <h2>Hai centrato il tetto corretto?</h2>
          <p>
            Controlla che la punta del pin cada esattamente sul tetto, quindi
            conferma per passare alla configurazione successiva.
          </p>
          <p>
            <strong>{project.location?.address || query}</strong>
          </p>
          <p>{status}</p>
        </div>
        <button type="button" className="yellow" onClick={confirmLocation}>
          Conferma tetto ›
        </button>
      </div>

      <VisualFooter
        left="I tuoi dati restano solo sul tuo dispositivo."
        right="Mappa satellitare interattiva da Google Maps."
      />
    </section>
  );
}

function mapPointsToMetric(
  points: Array<{ lat: number; lng: number }>,
  origin: { lat: number; lng: number },
) {
  const latitudeRadians = (origin.lat * Math.PI) / 180;
  return points.map((point) => ({
    x: (point.lng - origin.lng) * 111320 * Math.cos(latitudeRadians),
    y: (point.lat - origin.lat) * 110540,
  }));
}

function mapPolygonToMetric(points: Array<{ lat: number; lng: number }>) {
  const origin = points[0];
  return origin ? mapPointsToMetric(points, origin) : [];
}

function metricPointToMap(
  point: { x: number; y: number },
  origin: { lat: number; lng: number },
) {
  const latitudeRadians = (origin.lat * Math.PI) / 180;
  return {
    lat: origin.lat + point.y / 110540,
    lng: origin.lng + point.x / (111320 * Math.cos(latitudeRadians)),
  };
}

function rebuildPlaneFromMapPolygon(
  plane: RoofPlane,
  mapPolygon: Array<{ lat: number; lng: number }>,
  config: AppConfig,
) {
  const origin = mapPolygon[0];
  let nextPlane = updatePlaneArea({
    ...plane,
    mapPolygon,
    polygon: mapPolygonToMetric(mapPolygon),
    obstacles: origin
      ? plane.obstacles?.map((obstacle) => ({
          ...obstacle,
          polygon: mapPointsToMetric(obstacle.mapPolygon, origin),
        }))
      : plane.obstacles,
  });
  nextPlane = autoLayoutPlane(nextPlane, config);
  return nextPlane;
}

type MapVertexSelection = {
  source: "saved" | "draft";
  pointIndex: number;
  planeId?: string;
  obstacleId?: string;
};

function mapVertexIcon(
  google: any,
  selected: boolean,
  fillColor: string,
  strokeColor: string,
  magnification = 1,
) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: (selected ? 9 : 6) / magnification,
    fillColor: selected ? "#e11d48" : fillColor,
    fillOpacity: 1,
    strokeColor: selected ? "#ffffff" : strokeColor,
    strokeWeight: (selected ? 4 : 2) / magnification,
  };
}

function useDeleteSelectedVertex(enabled: boolean, onDelete: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      )
        return;
      event.preventDefault();
      onDelete();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onDelete]);
}

export function RoofStep({
  project,
  update,
  config,
  onConfirm,
}: StepProps & { onConfirm: () => void }) {
  const cfg = config!;
  const roofMapCanvasRef = useRef<HTMLDivElement | null>(null);
  const roofMapRef = useRef<any>(null);
  const magnification = project.roof.mapMagnification ?? 2;
  const drawingRef = useRef(false);
  const drawingSlopeRef = useRef(false);
  const overlaysRef = useRef<any[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [preview, setPreview] = useState(false);
  const layoutSourceRef = useRef<{ id: string; config: AppConfig } | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [draftPlaneName, setDraftPlaneName] = useState("");
  const [draftPoints, setDraftPoints] = useState<
    Array<{ lat: number; lng: number }>
  >([]);
  const [drawingStatus, setDrawingStatus] = useState(
    "Avvia il disegno e fai clic sugli angoli della falda.",
  );
  const [selectedVertex, setSelectedVertex] =
    useState<MapVertexSelection | null>(null);
  const [pitchOpen, setPitchOpen] = useState(false);
  const [obstaclesOpen, setObstaclesOpen] = useState(false);
  const [drawingObstacle, setDrawingObstacle] = useState(false);
  const [obstaclePlaneId, setObstaclePlaneId] = useState("");
  const [obstacleType, setObstacleType] = useState("Comignolo");
  const [subdivisionsOpen, setSubdivisionsOpen] = useState(false);
  const [drawingSlope, setDrawingSlope] = useState(false);
  const [slopePlaneId, setSlopePlaneId] = useState("");
  const drawnPlanes = project.roof.planes.filter(
    (plane) => (plane.mapPolygon?.length ?? 0) >= 3,
  );

  // Recompute legacy/imported layouts once per project/config with the current
  // projection and automatic orientation, without repacking on every keystroke.
  useEffect(() => {
    if (layoutSourceRef.current?.id === project.id && layoutSourceRef.current.config === cfg) return;
    layoutSourceRef.current = { id: project.id, config: cfg };
    update((p) => ({ ...p, roof: { ...p.roof, planes: assignRoofColors(p.roof.planes).map((plane) => autoLayoutPlane(plane, cfg)) } }));
  }, [project.id, cfg, update]);

  const obstaclePlanes = drawnPlanes.filter((plane) => plane.usable);
  const activeObstaclePlane =
    obstaclePlanes.find((plane) => plane.id === obstaclePlaneId) ??
    obstaclePlanes[0];
  const hasSavedObstacles = Boolean(activeObstaclePlane?.obstacles?.length);

  useEffect(() => {
    if (drawingObstacle) setDraftPoints([]);
    setSelectedVertex(null);
    setDrawingObstacle(false);
  }, [activeObstaclePlane?.id]);

  const activeSlopePlane = drawnPlanes.find((plane) => plane.id === slopePlaneId) ?? drawnPlanes[0];
  useEffect(() => {
    if (drawingSlope) setDraftPoints([]);
    setDrawingSlope(false);
    setSelectedVertex(null);
  }, [activeSlopePlane?.id]);

  drawingRef.current = drawing || drawingObstacle || drawingSlope;
  drawingSlopeRef.current = drawingSlope;
  useDeleteSelectedVertex(Boolean(selectedVertex), deleteSelectedRoofVertex);

  useEffect(() => {
    const key = googleMapsApiKey(config);
    if (!key || !project.location || !roofMapCanvasRef.current) {
      setDrawingStatus(
        "Per disegnare le falde del tetto è necessaria una posizione e Google Maps configurato.",
      );
      return;
    }

    let cancelled = false;
    let clickListener: { remove: () => void } | undefined;
    void loadGoogleMapsScript(key)
      .then((google) => {
        if (cancelled || !roofMapCanvasRef.current || !project.location) return;
        const map = new google.maps.Map(roofMapCanvasRef.current, {
          center: {
            lat: project.location.latitude,
            lng: project.location.longitude,
          },
          zoom: MAX_SATELLITE_ZOOM_FALLBACK,
          mapTypeId: "satellite",
          tilt: 0,
          heading: 0,
          ...googleMapControlOptions(google),
          zoomControl: false,
          draggable: false,
          scrollwheel: false,
          keyboardShortcuts: false,
          gestureHandling: "none",
          disableDoubleClickZoom: true,
        });
        roofMapRef.current = map;
        zoomMapToMaximum(google, map, {
          lat: project.location.latitude,
          lng: project.location.longitude,
        });
        clickListener = map.addListener("click", (event: any) => {
          if (!drawingRef.current || !event.latLng) return;
          setDraftPoints((points) => drawingSlopeRef.current && points.length >= 2
            ? points
            : [...points, { lat: event.latLng.lat(), lng: event.latLng.lng() }],
          );
        });
        setMapReady(true);
      })
      .catch(() =>
        setDrawingStatus(
          "Non riesco a caricare la vista satellitare di Google Maps.",
        ),
      );

    return () => {
      cancelled = true;
      clickListener?.remove();
      roofMapRef.current = null;
      setMapReady(false);
    };
  }, [config, project.location?.latitude, project.location?.longitude]);

  useEffect(() => {
    const google = (window as any).google;
    const map = roofMapRef.current;
    if (!mapReady || !google?.maps || !map) return;

    overlaysRef.current.forEach((overlay) => overlay.setMap(null));
    overlaysRef.current = [];

    drawnPlanes.forEach((plane) => {
      const color = roofColor(plane);
      const polygon = new google.maps.Polygon({
        map,
        paths: plane.mapPolygon,
        clickable: false,
        strokeColor: color,
        strokeOpacity: plane.usable ? 1 : 0.45,
        strokeWeight: 3 / magnification,
        fillColor: color,
        fillOpacity: plane.usable ? (preview ? 0.08 : 0.14) : 0.04,
      });
      overlaysRef.current.push(polygon);
      (plane.slopeLines ?? []).forEach((line) => {
        overlaysRef.current.push(new google.maps.Polyline({
          map,
          path: line.points,
          clickable: false,
          strokeColor: color,
          strokeOpacity: 1,
          strokeWeight: 4 / magnification,
        }));
      });
      if (preview && plane.usable && plane.mapPolygon?.[0]) {
        plane.panels.forEach((panel) => {
          overlaysRef.current.push(new google.maps.Polygon({
            map,
            paths: panelFootprint(plane, panel, cfg).map((point) => metricPointToMap(point, plane.mapPolygon![0])),
            clickable: false,
            strokeColor: "#d9f4ff",
            strokeOpacity: 1,
            strokeWeight: 1 / magnification,
            fillColor: "#1570a6",
            fillOpacity: 0.85,
          }));
        });
      }
      (plane.obstacles ?? []).forEach((obstacle) => {
        overlaysRef.current.push(
          new google.maps.Polygon({
            map,
            paths: obstacle.mapPolygon,
            clickable: false,
            strokeColor: "#ff4d4f",
            strokeWeight: 3 / magnification,
            fillColor: "#ff4d4f",
            fillOpacity: 0.42,
          }),
        );
        // Existing geometry stays editable independently of the creation form.
        if (preview) return;
        obstacle.mapPolygon.forEach((point, pointIndex) => {
          const marker = new google.maps.Marker({
            map,
            position: point,
            draggable: true,
            cursor: "grab",
            title: `Seleziona il punto ${pointIndex + 1} di ${obstacle.label}`,
            icon: mapVertexIcon(
              google,
              selectedVertex?.source === "saved" &&
                selectedVertex.planeId === plane.id &&
                selectedVertex.obstacleId === obstacle.id &&
                selectedVertex.pointIndex === pointIndex,
              "#ff4d4f",
              "#ffffff",
              magnification,
            ),
          });
          marker.addListener("click", () => {
            setSelectedVertex({
              source: "saved",
              planeId: plane.id,
              obstacleId: obstacle.id,
              pointIndex,
            });
            setDrawingStatus(
              "Punto ostacolo selezionato. Premi Canc o Backspace per rimuoverlo.",
            );
          });
          marker.addListener("dragend", (event: any) => {
            if (!event.latLng) return;
            const moved = { lat: event.latLng.lat(), lng: event.latLng.lng() };
            changeObstacle(plane.id, obstacle.id, (points) =>
              points.map((value, index) =>
                index === pointIndex ? moved : value,
              ),
            );
          });
          overlaysRef.current.push(marker);
        });
      });
      if (!preview) plane.mapPolygon?.forEach((point, pointIndex) => {
        const marker = new google.maps.Marker({
          map,
          position: point,
          clickable: true,
          draggable: true,
          cursor: "grab",
          title: `Trascina per spostare o fai clic per rimuovere il punto ${pointIndex + 1}`,
          icon: mapVertexIcon(
            google,
            selectedVertex?.source === "saved" &&
              selectedVertex.planeId === plane.id &&
              !selectedVertex.obstacleId &&
              selectedVertex.pointIndex === pointIndex,
            color,
            "#ffffff",
            magnification,
          ),
        });
        marker.addListener("dragend", (event: any) => {
          if (!event.latLng) return;
          const movedPoint = {
            lat: event.latLng.lat(),
            lng: event.latLng.lng(),
          };
          update((currentProject) => ({
            ...currentProject,
            roof: {
              ...currentProject.roof,
              confirmedByUser: false,
              planes: currentProject.roof.planes.map((currentPlane) => {
                if (currentPlane.id !== plane.id || !currentPlane.mapPolygon)
                  return currentPlane;
                const nextMapPolygon = currentPlane.mapPolygon.map(
                  (currentPoint, currentIndex) =>
                    currentIndex === pointIndex ? movedPoint : currentPoint,
                );
                return rebuildPlaneFromMapPolygon(
                  currentPlane,
                  nextMapPolygon,
                  cfg,
                );
              }),
            },
          }));
          setDrawingStatus(
            `${plane.label} aggiornata. Puoi spostare ancora i punti o confermare.`,
          );
        });
        marker.addListener("click", () => {
          setSelectedVertex({
            source: "saved",
            planeId: plane.id,
            pointIndex,
          });
          setDrawingStatus(
            `Punto ${pointIndex + 1} di ${plane.label} selezionato. Premi Canc o Backspace per rimuoverlo.`,
          );
        });
        overlaysRef.current.push(marker);
      });
    });

    if (draftPoints.length > 0) {
      const draftColor = drawingObstacle ? "#ff4d4f" : drawingSlope ? roofColor(activeSlopePlane) : nextRoofColor(drawnPlanes);
      const DraftOverlay = drawingSlope ? google.maps.Polyline : google.maps.Polygon;
      const draft = new DraftOverlay({
        map,
        ...(drawingSlope ? { path: draftPoints } : { paths: draftPoints }),
        clickable: false,
        strokeColor: draftColor,
        strokeOpacity: 1,
        strokeWeight: 3 / magnification,
        fillColor: draftColor,
        fillOpacity: !drawingSlope && draftPoints.length >= 3 ? 0.3 : 0,
      });
      overlaysRef.current.push(draft);
      draftPoints.forEach((point, pointIndex) => {
        const marker = new google.maps.Marker({
          map,
          position: point,
          clickable: true,
          draggable: true,
          cursor: "grab",
          title: drawingSlope
            ? `Trascina per spostare il punto ${pointIndex + 1} della separazione`
            : `Trascina per spostare o fai clic per rimuovere il punto ${pointIndex + 1}`,
          icon: mapVertexIcon(
            google,
            selectedVertex?.source === "draft" &&
              selectedVertex.pointIndex === pointIndex,
            "#ffffff",
            draftColor,
            magnification,
          ),
        });
        marker.addListener("dragend", (event: any) => {
          if (!event.latLng) return;
          const movedPoint = {
            lat: event.latLng.lat(),
            lng: event.latLng.lng(),
          };
          setDraftPoints((points) =>
            points.map((currentPoint, currentIndex) =>
              currentIndex === pointIndex ? movedPoint : currentPoint,
            ),
          );
        });
        marker.addListener("click", () => {
          setSelectedVertex({ source: "draft", pointIndex });
          setDrawingStatus(
            `Punto ${pointIndex + 1} selezionato. Premi Canc o Backspace per rimuoverlo.`,
          );
        });
        overlaysRef.current.push(marker);
      });
    }

    return () => {
      overlaysRef.current.forEach((overlay) => overlay.setMap(null));
      overlaysRef.current = [];
    };
  }, [
    draftPoints,
    drawnPlanes,
    mapReady,
    selectedVertex,
    obstaclesOpen,
    drawing,
    drawingObstacle,
    drawingSlope,
    magnification,
    preview,
    cfg,
  ]);

  function changeObstacle(
    planeId: string,
    obstacleId: string,
    transform: (
      points: Array<{ lat: number; lng: number }>,
    ) => Array<{ lat: number; lng: number }>,
  ) {
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        confirmedByUser: false,
        planes: p.roof.planes.map((plane) => {
          if (plane.id !== planeId || !plane.mapPolygon?.[0]) return plane;
          const nextPlane = {
            ...plane,
            obstacles: (plane.obstacles ?? []).map((obstacle) => {
              if (obstacle.id !== obstacleId) return obstacle;
              const mapPolygon = transform(obstacle.mapPolygon);
              return {
                ...obstacle,
                mapPolygon,
                polygon: mapPointsToMetric(mapPolygon, plane.mapPolygon![0]),
              };
            }),
          };
          return autoLayoutPlane(nextPlane, cfg);
        }),
      },
    }));
  }

  function changeSlopeLines(transform: (lines: RoofSlopeLine[]) => RoofSlopeLine[]) {
    if (!activeSlopePlane) return;
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        confirmedByUser: false,
        planes: p.roof.planes.map((plane) => {
          if (plane.id !== activeSlopePlane.id) return plane;
          const nextPlane = { ...plane, slopeLines: transform(plane.slopeLines ?? []) };
          return autoLayoutPlane(nextPlane, cfg);
        }),
      },
    }));
  }

  function cancelSlopeDrawing() {
    if (drawingSlope) {
      setDraftPoints([]);
      setDrawingStatus("Separazione annullata. Puoi modificare o confermare le falde.");
    }
    setDrawingSlope(false);
    setSelectedVertex(null);
  }

  function completeSlopeLine() {
    if (!activeSlopePlane || draftPoints.length !== 2) return;
    const slopeLine: RoofSlopeLine = {
      id: newId("slope"),
      label: `Separazione falda ${(activeSlopePlane.slopeLines?.length ?? 0) + 1}`,
      points: [draftPoints[0], draftPoints[1]],
    };
    changeSlopeLines((lines) => [...lines, slopeLine]);
    setDrawingSlope(false);
    setDraftPoints([]);
    setSelectedVertex(null);
    setDrawingStatus("Separazione interna salvata. Puoi confermare le superfici.");
  }

  function closeObstacles() {
    setObstaclesOpen(false);
    setDrawingObstacle(false);
    if (drawingObstacle) setDraftPoints([]);
    setSelectedVertex(null);
  }

  function completeObstacle() {
    if (!activeObstaclePlane?.mapPolygon?.[0] || draftPoints.length < 3) return;
    const obstacle = {
      id: newId("obstacle"),
      label: `${obstacleType} ${(activeObstaclePlane.obstacles?.length ?? 0) + 1}`,
      mapPolygon: draftPoints,
      polygon: mapPointsToMetric(
        draftPoints,
        activeObstaclePlane.mapPolygon[0],
      ),
    };
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        confirmedByUser: false,
        planes: p.roof.planes.map((plane) => {
          if (plane.id !== activeObstaclePlane.id) return plane;
          const nextPlane = {
            ...plane,
            obstacles: [...(plane.obstacles ?? []), obstacle],
          };
          return autoLayoutPlane(nextPlane, cfg);
        }),
      },
    }));
    setDrawingObstacle(false);
    setDraftPoints([]);
    setSelectedVertex(null);
    setDrawingStatus("Ostacolo salvato: pannelli ridisposti automaticamente.");
  }

  function deleteObstacle(obstacleId: string) {
    if (!activeObstaclePlane) return;
    setSelectedVertex(null);
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        confirmedByUser: false,
        planes: p.roof.planes.map((plane) => {
          if (plane.id !== activeObstaclePlane.id) return plane;
          const nextPlane = {
            ...plane,
            obstacles: (plane.obstacles ?? []).filter(
              (item) => item.id !== obstacleId,
            ),
          };
          return autoLayoutPlane(nextPlane, cfg);
        }),
      },
    }));
  }

  function deleteSelectedRoofVertex() {
    if (!selectedVertex) return;
    if (selectedVertex.source === "draft") {
      setDraftPoints((points) =>
        points.filter((_, index) => index !== selectedVertex.pointIndex),
      );
      setSelectedVertex(null);
      setDrawingStatus("Punto rimosso dal disegno in corso.");
      return;
    }

    const selectedPlane = project.roof.planes.find(
      (plane) => plane.id === selectedVertex.planeId,
    );
    if (selectedVertex.obstacleId) {
      if (!selectedPlane) return;
      const obstacle = selectedPlane.obstacles?.find(
        (item) => item.id === selectedVertex.obstacleId,
      );
      if (!obstacle || obstacle.mapPolygon.length <= 3) {
        setDrawingStatus(
          "Un ostacolo deve avere almeno 3 punti. Sposta il punto o elimina l’intero ostacolo.",
        );
        return;
      }
      changeObstacle(selectedPlane.id, obstacle.id, (points) =>
        points.filter((_, index) => index !== selectedVertex.pointIndex),
      );
      setSelectedVertex(null);
      return;
    }
    if ((selectedPlane?.mapPolygon?.length ?? 0) <= 3) {
      setDrawingStatus(
        "Una falda deve avere almeno 3 punti. Sposta il punto oppure elimina l’intera falda.",
      );
      return;
    }
    update((currentProject) => ({
      ...currentProject,
      roof: {
        ...currentProject.roof,
        confirmedByUser: false,
        planes: currentProject.roof.planes.map((plane) => {
          if (plane.id !== selectedVertex.planeId || !plane.mapPolygon)
            return plane;
          const nextMapPolygon = plane.mapPolygon.filter(
            (_, index) => index !== selectedVertex.pointIndex,
          );
          return rebuildPlaneFromMapPolygon(plane, nextMapPolygon, cfg);
        }),
      },
    }));
    setSelectedVertex(null);
    setDrawingStatus(`Punto rimosso da ${selectedPlane?.label ?? "falda"}.`);
  }

  const setPlane = (id: string, patch: Partial<RoofPlane>) =>
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        confirmedByUser: false,
        planes: p.roof.planes.map((plane) => {
          if (plane.id !== id) return plane;
          const nextPlane = updatePlaneArea({ ...plane, ...patch });
          return autoLayoutPlane(nextPlane, cfg);
        }),
      },
    }));

  function renameRoofPlane(id: string, label: string) {
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        planes: p.roof.planes.map((plane) => plane.id === id ? { ...plane, label } : plane),
      },
    }));
  }

  function startDrawing() {
    setDraftPlaneName(`Falda ${drawnPlanes.length + 1}`);
    setDrawingSlope(false);
    setDrawingObstacle(false);
    setDraftPoints([]);
    setSelectedVertex(null);
    setDrawing(true);
    setDrawingStatus(
      "Fai clic sugli angoli della falda, seguendone il perimetro. Servono almeno 3 punti.",
    );
  }

  function cancelDrawing() {
    setDraftPlaneName("");
    setDraftPoints([]);
    setSelectedVertex(null);
    setDrawing(false);
    setDrawingStatus("Disegno annullato. Puoi iniziare una nuova falda.");
  }

  function completeDrawing() {
    const label = draftPlaneName.trim();
    if (!label) {
      setDrawingStatus("Inserisci il nome della falda prima di salvarla.");
      return;
    }
    if (draftPoints.length < 3) {
      setDrawingStatus("Aggiungi almeno 3 punti per chiudere la falda.");
      return;
    }

    let plane = updatePlaneArea({
      id: newId("plane"),
      label,
      color: nextRoofColor(drawnPlanes),
      polygon: mapPolygonToMetric(draftPoints),
      mapPolygon: draftPoints,
      areaM2: 0,
      azimuthDeg: 180,
      pitchPreset: "normal",
      pitchDeg: cfg.roof.defaultPitchDeg.normal,
      usable: true,
      layoutOrientation: "portrait",
      panels: [],
    });
    plane = autoLayoutPlane(plane, cfg);

    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        detectionMethod: "manual",
        confirmedByUser: false,
        planes:
          p.roof.detectionMethod === "fixture"
            ? [plane]
            : [...p.roof.planes, plane],
      },
    }));
    setDraftPoints([]);
    setSelectedVertex(null);
    setDrawing(false);
    setDraftPlaneName("");
    setDrawingStatus(
      "Falda salvata. Disegnane un’altra oppure visualizza la disposizione automatica.",
    );
  }

  function deletePlane(id: string) {
    setSelectedVertex(null);
    if (id === activeSlopePlane?.id) {
      setDrawingSlope(false);
      if (drawingSlope) setDraftPoints([]);
    }
    if (id === activeObstaclePlane?.id) {
      setDrawingObstacle(false);
      if (drawingObstacle) setDraftPoints([]);
    }
    update((p) => ({
      ...p,
      roof: {
        ...p.roof,
        confirmedByUser: false,
        planes: p.roof.planes.filter((plane) => plane.id !== id),
      },
    }));
  }

  const totalPanels = drawnPlanes
    .filter((plane) => plane.usable)
    .reduce((total, plane) => total + plane.panels.length, 0);

  return (
    <section className="location-page roof-page">
      <div className="map-workspace">
        <div className="google-map-shell roof-drawing-step roof-map-shell">
          <RoofMapViewport
            canvasRef={roofMapCanvasRef}
            mapRef={roofMapRef}
            overlaysRef={overlaysRef}
            ready={mapReady}
            magnification={magnification}
          />
          <button
            type="button"
            className="map-scroll-cta"
            onClick={() =>
              document
                .getElementById("roof-help")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            Come disegnare le falde ↓
          </button>

          <aside className="glass-card map-overlay-panel roof-panel roof-drawing-panel">
            {preview ? (
              <RoofPreviewSummary
                planes={drawnPlanes}
                config={cfg}
                onEdit={() => setPreview(false)}
                onConfirm={() => {
                  update((p) => ({ ...p, roof: { ...p.roof, confirmedByUser: true } }));
                  onConfirm();
                }}
              />
            ) : (
              <>
            <div className="roof-manager-heading">
              <h2>Falde disponibili</h2>
              {!drawing && drawnPlanes.length > 0 && (
                <button
                  type="button"
                  className="primary roof-add-plane-icon"
                  aria-label="Disegna un’altra falda"
                  title="Disegna un’altra falda"
                  onClick={startDrawing}
                  disabled={!mapReady || drawingObstacle || drawingSlope}
                >
                  <Plus size={20} aria-hidden="true" />
                </button>
              )}
            </div>
            <p>{drawingStatus}</p>

            {drawing ? (
              <div className="roof-drawing-actions">
                <label className="roof-plane-name-field" htmlFor="roof-draft-plane-name">
                  Nome della falda
                  <input
                    id="roof-draft-plane-name"
                    type="text"
                    value={draftPlaneName}
                    onChange={(event) => setDraftPlaneName(event.target.value)}
                    placeholder="Es. Falda sud"
                    maxLength={80}
                    required
                  />
                </label>
                <strong>{draftPoints.length} punti inseriti</strong>
                <button
                  type="button"
                  onClick={() =>
                    setDraftPoints((points) => points.slice(0, -1))
                  }
                  disabled={!draftPoints.length}
                >
                  Annulla ultimo punto
                </button>
                <button
                  type="button"
                  className="yellow"
                  onClick={completeDrawing}
                  disabled={draftPoints.length < 3 || !draftPlaneName.trim()}
                >
                  Completa falda
                </button>
                <button
                  type="button"
                  className="outline"
                  onClick={cancelDrawing}
                >
                  Annulla disegno
                </button>
              </div>
            ) : drawnPlanes.length === 0 ? (
              <button
                type="button"
                className="primary roof-draw-start"
                onClick={startDrawing}
                disabled={!mapReady || drawingObstacle || drawingSlope}
              >
                + Disegna la prima falda
              </button>
            ) : null}

            <div className="roof-area-list">
              {drawnPlanes.length === 0 ? (
                <p className="roof-empty-state">
                  Nessuna falda ancora disegnata.
                </p>
              ) : (
                drawnPlanes.map((plane, planeIndex) => (
                  <div className="plane-row" key={plane.id} style={roofPlaneStyle(plane)} data-usable={plane.usable}>
                    <button
                      type="button"
                      onClick={() =>
                        setPlane(plane.id, { usable: !plane.usable })
                      }
                      aria-label={`${plane.usable ? "Escludi" : "Includi"} ${plane.label}`}
                    >
                      {plane.usable ? "✓" : "×"}
                    </button>
                    <input
                      className="roof-plane-name"
                      type="text"
                      aria-label={`Nome della falda ${planeIndex + 1}`}
                      value={plane.label}
                      maxLength={80}
                      onChange={(event) => renameRoofPlane(plane.id, event.target.value)}
                      onBlur={(event) => {
                        const name = event.target.value.trim() || `Falda ${planeIndex + 1}`;
                        if (name !== plane.label) renameRoofPlane(plane.id, name);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                    <span className="roof-plane-area">{Math.round(plane.areaM2)} m²</span>
                    <button
                      type="button"
                      className="roof-delete-area"
                      aria-label={`Elimina ${plane.label}`}
                      title={`Elimina ${plane.label}`}
                      onClick={() => deletePlane(plane.id)}
                    >
                      <Minus size={18} aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>

            {drawnPlanes.length > 0 && (
              <>
                <div className="summary-strip">
                  <strong>
                    {drawnPlanes.length} falde · area in pianta{" "}
                    {Math.round(
                      drawnPlanes.reduce((sum, plane) => sum + plane.areaM2, 0),
                    )}{" "}
                    m²
                  </strong>
                  <br />
                  Stima iniziale: {totalPanels} pannelli ·{" "}
                  {((totalPanels * cfg.pv.panel.powerWp) / 1000).toFixed(1)} kWp
                </div>
                <button
                  type="button"
                  className="yellow"
                  disabled={
                    drawing || drawingObstacle || drawingSlope || draftPoints.length > 0
                  }
                  onClick={() => {
                    update((p) => ({ ...p, roof: { ...p.roof, confirmedByUser: false, planes: p.roof.planes.map((plane) => autoLayoutPlane(plane, cfg)) } }));
                    setSelectedVertex(null);
                    setPreview(true);
                  }}
                >
                  Vedi i pannelli
                </button>
                <div className="roof-optional-settings">
                  <button
                    type="button"
                    id="roof-pitch-toggle"
                    className="roof-accordion-toggle"
                    aria-expanded={pitchOpen}
                    aria-controls="roof-pitch-editor"
                    onClick={() => setPitchOpen((open) => !open)}
                  >
                    Inclinazione del tetto
                    <ChevronDown size={18} aria-hidden="true" />
                  </button>
                  {pitchOpen && (
                <div
                  id="roof-pitch-editor"
                  className="pitch-grid"
                  role="region"
                  aria-labelledby="roof-pitch-toggle"
                >
                  {(["flat", "low", "normal", "steep"] as const).map(
                    (pitch) => (
                      <button
                        type="button"
                        key={pitch}
                        aria-pressed={drawnPlanes[0]?.pitchPreset === pitch}
                        className={
                          drawnPlanes[0]?.pitchPreset === pitch
                            ? "selected"
                            : ""
                        }
                        onClick={() =>
                          update((p) => ({
                            ...p,
                            roof: {
                              ...p.roof,
                              confirmedByUser: false,
                              planes: p.roof.planes.map((plane) => {
                                const nextPlane = {
                                  ...plane,
                                  pitchPreset: pitch,
                                  pitchDeg: cfg.roof.defaultPitchDeg[pitch],
                                };
                                return autoLayoutPlane(nextPlane, cfg);
                              }),
                            },
                          }))
                        }
                      >
                        {pitchLabel(pitch)}
                      </button>
                    ),
                  )}
                </div>
                  )}
                <button
                  type="button"
                  id="roof-obstacle-toggle"
                  className="roof-accordion-toggle"
                  aria-expanded={obstaclesOpen}
                  aria-controls="roof-obstacle-editor"
                  disabled={drawing || drawingSlope}
                  onClick={() =>
                    obstaclesOpen ? closeObstacles() : setObstaclesOpen(true)
                  }
                >
                  Ostacoli sul tetto
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
                {obstaclesOpen && (
                  <div
                    id="roof-obstacle-editor"
                    className="roof-obstacle-editor"
                    role="region"
                    aria-labelledby="roof-obstacle-toggle"
                  >
                    <p>
                      Disegna le zone non utilizzabili. Trascina i punti o
                      selezionali e premi Canc per correggerli.
                    </p>
                    <label>
                      Falda dell’ostacolo
                      <select
                        value={activeObstaclePlane?.id ?? ""}
                        disabled={drawing || drawingSlope || !activeObstaclePlane}
                        onChange={(event) => {
                          setObstaclePlaneId(event.target.value);
                          setDrawingObstacle(false);
                          setDraftPoints([]);
                          setSelectedVertex(null);
                        }}
                      >
                        {obstaclePlanes.map((plane) => (
                          <option key={plane.id} value={plane.id}>
                            {plane.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className={`roof-obstacle-toolbar ${hasSavedObstacles && !drawingObstacle ? "has-items" : ""}`}>
                      <label>
                        Tipo di ostacolo
                        <select
                          value={obstacleType}
                          onChange={(event) => setObstacleType(event.target.value)}
                        >
                          <option>Comignolo</option>
                          <option>Finestra</option>
                          <option>Lucernario</option>
                          <option>Altro ostacolo</option>
                        </select>
                      </label>
                      {!drawingObstacle && (
                        <button
                          type="button"
                          className={hasSavedObstacles ? "primary roof-add-plane-icon" : "primary"}
                          aria-label={hasSavedObstacles ? "Disegna un altro ostacolo" : undefined}
                          title={hasSavedObstacles ? "Disegna un altro ostacolo" : undefined}
                          disabled={!mapReady || drawing || drawingSlope || !activeObstaclePlane}
                          onClick={() => {
                            setDrawing(false);
                            setDrawingObstacle(true);
                            setDraftPoints([]);
                            setSelectedVertex(null);
                            setDrawingStatus("Fai clic sugli angoli dell’ostacolo, poi completa il perimetro.");
                          }}
                        >
                          {hasSavedObstacles
                            ? <Plus size={20} aria-hidden="true" />
                            : "Disegna ostacolo sulla mappa"}
                        </button>
                      )}
                    </div>
                    {drawingObstacle && (
                      <>
                        <span>{draftPoints.length} punti</span>
                        <button
                          type="button"
                          className="yellow"
                          disabled={draftPoints.length < 3}
                          onClick={completeObstacle}
                        >
                          Completa ostacolo
                        </button>
                        <button
                          type="button"
                          className="outline"
                          onClick={() => {
                            setDrawingObstacle(false);
                            setDraftPoints([]);
                            setSelectedVertex(null);
                          }}
                        >
                          Annulla ostacolo
                        </button>
                      </>
                    )}
                    {(activeObstaclePlane?.obstacles ?? []).map((obstacle) => (
                      <div className="roof-obstacle-row" key={obstacle.id}>
                        <span>{obstacle.label}</span>
                        <button
                          type="button"
                          className="roof-remove-item-icon"
                          aria-label={`Elimina ${obstacle.label}`}
                          title={`Elimina ${obstacle.label}`}
                          disabled={drawing || drawingSlope}
                          onClick={() => deleteObstacle(obstacle.id)}
                        >
                          <Minus size={18} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    {!activeObstaclePlane && (
                      <p>
                        Includi almeno una falda disegnata per aggiungere
                        ostacoli.
                      </p>
                    )}
                    <button
                      type="button"
                      className="outline"
                      onClick={closeObstacles}
                    >
                      Richiudi ostacoli
                    </button>
                  </div>
                )}
                  <RoofSubdivisions
                    planes={drawnPlanes}
                    activePlane={activeSlopePlane}
                    open={subdivisionsOpen}
                    drawing={drawingSlope}
                    busy={drawing || drawingObstacle}
                    ready={mapReady}
                    pointCount={draftPoints.length}
                    onToggle={() => {
                      if (subdivisionsOpen) cancelSlopeDrawing();
                      setSubdivisionsOpen((open) => !open);
                    }}
                    onPlaneChange={(id) => {
                      cancelSlopeDrawing();
                      setSlopePlaneId(id);
                    }}
                    onStart={() => {
                      setDraftPoints([]);
                      setSelectedVertex(null);
                      setDrawingSlope(true);
                      setDrawingStatus("Fai clic sui due estremi della separazione interna.");
                    }}
                    onCancel={cancelSlopeDrawing}
                    onSave={completeSlopeLine}
                    onDelete={(id) => changeSlopeLines((lines) => lines.filter((line) => line.id !== id))}
                  />
                </div>
              </>
            )}
              </>
            )}
            <MapZoomControls
              magnification={magnification}
              ready={mapReady}
              onChange={(mapMagnification) => update((p) => ({
                ...p, roof: { ...p.roof, mapMagnification },
              }))}
              onRecenter={() => project.location && roofMapRef.current?.setCenter({
                lat: project.location.latitude,
                lng: project.location.longitude,
              })}
            />
          </aside>
        </div>
      </div>

      <div className="location-title-band" id="roof-help">
        <button type="button" className="back-link dark">
          ‹ Torna alla mappa
        </button>
        <p className="eyebrow green">Tetto</p>
        <h1>Disegna le falde per i pannelli</h1>
      </div>

      <div className="location-topbar roof-instructions">
        <p>
          Sulla foto satellitare, disegna una per una le falde del tetto sulle
          quali vuoi installare i pannelli. L’area in m² viene calcolata
          automaticamente come informazione durante il wizard.
        </p>
        <ol>
          <li>Premi “Disegna la prima falda” e inserisci il nome della superficie.</li>
          <li>Fai clic sugli angoli seguendo il perimetro.</li>
          <li>
            Trascina i punti per correggerli. Per rimuoverne uno, selezionalo
            con un clic e premi Canc o Backspace.
          </li>
          <li>Completa la falda e ripeti per ogni falda del tetto.</li>
          <li>
            Facoltativamente, apri “Ostacoli sul tetto” per escludere comignoli,
            finestre o altre zone prima di confermare.
          </li>
          <li>
            Apri “Suddivisioni interne” per indicare le separazioni della falda.
          </li>
          <li>
            Premi “Vedi i pannelli”, verifica la capacità stimata e continua ai consumi.
          </li>
        </ol>
      </div>

      <VisualFooter
        left="La mappa resta fissa sul tetto scelto nello step precedente."
        right={preview ? "Per correggere il layout, torna a Modifica superfici." : "Trascina i punti per correggere le falde disegnate."}
      />
    </section>
  );
}

export function ConsumptionStep({ project, update, onBack, onContinue, onSave }: StepProps & { onBack: () => void; onContinue: () => void; onSave: () => void }) {
  const e = project.currentHome.electricityInput;
  const [guided, setGuided] = useState(true);
  if (guided) return <ConsumptionWizard project={project} update={update} onManual={() => setGuided(false)} onBack={onBack} onContinue={onContinue} />;
  return (
    <section className="consumption-manual">
      <h1>Consumi attuali</h1>
      <p>Inserisci i consumi della bolletta o modifica i valori stimati.</p>
      <button type="button" className="consumption-text-button" onClick={() => setGuided(true)}>Non conosco i consumi: aiutami a stimarli →</button>
      {e.qualityFlags.includes(HOUSEHOLD_ESTIMATE_FLAG) && <p className="consumption-note" role="status">Stai usando una stima indicativa delle tue abitudini. Puoi sostituirla con i dati della bolletta.</p>}
      <div className="form">
        <label>
          Modalità
          <select
            value={e.mode}
            onChange={(ev) =>
              update((p) => ({
                ...p,
                currentHome: {
                  ...p.currentHome,
                  electricityInput: {
                    ...p.currentHome.electricityInput,
                    mode: ev.target.value as "annual" | "monthly" | "hourly",
                    qualityFlags: p.currentHome.electricityInput.qualityFlags.filter(flag => flag !== HOUSEHOLD_ESTIMATE_FLAG),
                    estimateAnswers: undefined,
                  },
                },
              }))
            }
          >
            <option value="annual">Veloce: annuo</option>
            <option value="monthly">Precisa: mensile</option>
            {e.hourlyKwh?.length === 8760 && <option value="hourly">Dettagliata: oraria (dati importati)</option>}
          </select>
        </label>
        {e.mode === "annual" && (
          <label>
            kWh/anno
            <input
              type="number"
              value={e.annualKwh ?? 0}
              onChange={(ev) =>
                update((p) => ({
                  ...p,
                  currentHome: {
                    ...p.currentHome,
                    electricityInput: {
                      ...p.currentHome.electricityInput,
                      annualKwh: +ev.target.value,
                      qualityFlags: p.currentHome.electricityInput.qualityFlags.filter(flag => flag !== HOUSEHOLD_ESTIMATE_FLAG),
                      estimateAnswers: undefined,
                    },
                  },
                }))
              }
            />
          </label>
        )}
        {e.mode === "monthly" &&
          Array.from({ length: 12 }, (_, i) => (
            <label key={i}>
              Mese {i + 1}
              <input
                type="number"
                value={e.monthlyKwh?.[i] ?? 250}
                onChange={(ev) =>
                  update((p) => {
                    const m = [
                      ...(p.currentHome.electricityInput.monthlyKwh ??
                        Array(12).fill(250)),
                    ];
                    m[i] = +ev.target.value;
                    return {
                      ...p,
                      currentHome: {
                        ...p.currentHome,
                        electricityInput: {
                          ...p.currentHome.electricityInput,
                          monthlyKwh: m,
                          qualityFlags: p.currentHome.electricityInput.qualityFlags.filter(flag => flag !== HOUSEHOLD_ESTIMATE_FLAG),
                          estimateAnswers: undefined,
                        },
                      },
                    };
                  })
                }
              />
            </label>
          ))}
        <label>
          Occupanti
          <input
            type="number"
            value={project.currentHome.occupants}
            onChange={(ev) =>
              update((p) => ({
                ...p,
                currentHome: { ...p.currentHome, occupants: +ev.target.value },
              }))
            }
          />
        </label>
        <label>
          Superficie m²
          <input
            type="number"
            value={project.currentHome.floorAreaM2}
            onChange={(ev) =>
              update((p) => ({
                ...p,
                currentHome: {
                  ...p.currentHome,
                  floorAreaM2: +ev.target.value,
                },
              }))
            }
          />
        </label>
        <label>
          Presenza
          <select
            value={project.currentHome.occupancyProfile}
            onChange={(ev) =>
              update((p) => ({
                ...p,
                currentHome: {
                  ...p.currentHome,
                  occupancyProfile: ev.target
                    .value as Project["currentHome"]["occupancyProfile"],
                },
              }))
            }
          >
            <option value="morning">mattina</option>
            <option value="day">giorno</option>
            <option value="evening">sera</option>
            <option value="always">sempre</option>
          </select>
        </label>
        <label>
          Metano Smc/anno
          <input
            type="number"
            value={project.currentHome.heating.gasSmcYear ?? 0}
            onChange={(ev) =>
              update((p) => ({
                ...p,
                currentHome: {
                  ...p.currentHome,
                  heating: {
                    ...p.currentHome.heating,
                    gasSmcYear: +ev.target.value,
                  },
                },
              }))
            }
          />
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={onBack}>Indietro</button>
        <button type="button" onClick={onSave}><Save size={16} /> Salva</button>
        <button type="button" className="yellow" onClick={onContinue}>Continua alla casa futura →</button>
      </div>
    </section>
  );
}

function FutureStep({ project, update, config }: StepProps & { config: AppConfig }) {
  const f = project.futureHome;
  const currentKwh = hourlyFromElectricityInput(project.currentHome.electricityInput, project.currentHome.occupancyProfile, config).reduce((total, value) => total + value, 0);
  const extraKwh = futureHomeExtraLoads(project.currentHome, f, config).reduce((total, value) => total + value, 0);
  const evKwh = evHomeLoad(project.mobility, config).reduce((total, value) => total + value, 0);
  const futureKwh = Math.round(currentKwh + extraKwh + evKwh);
  return (
    <section className="future-step visual-future">
      <div className="future-hero">
        <h1>Immagina la tua casa di domani</h1>
        <p>
          Scegli quali soluzioni vuoi adottare: vedrai subito come cambia il
          consumo annuo di energia della tua casa.
        </p>
        <div className="callout pv">
          🌿 Fotovoltaico
          <br />
          <small>produce energia pulita</small>
        </div>
        <div className="callout hp">
          ≋ Pompa di calore
          <br />
          <small>riscalda la tua casa</small>
        </div>
        <div className="callout hw">
          ♨ Acqua calda elettrica
          <br />
          <small>più comfort, meno emissioni</small>
        </div>
        <div className="callout cook">
          ▦ Piano a induzione
          <br />
          <small>cucina più efficiente</small>
        </div>
        <div className="callout ev">
          🚘 Auto elettrica
          <br />
          <small>per una mobilità sostenibile</small>
        </div>
      </div>
      <aside className="glass-card future-panel">
        <h2>Scegli la tua casa di domani</h2>
        <div className="recommended-choice">
          🌿 <strong>Casa completamente elettrica</strong>
          <span>Consigliato</span>
        </div>
        <Switch
          label="Pompa di calore"
          text="Per riscaldamento e raffrescamento più efficienti."
          checked={f.heatPumpEnabled}
          onChange={(v) =>
            update((p) => ({
              ...p,
              futureHome: { ...p.futureHome, heatPumpEnabled: v },
            }))
          }
        />
        <Switch
          label="Acqua calda elettrica"
          text="Scalda l’acqua con l’energia del sole."
          checked={f.electricHotWaterEnabled}
          onChange={(v) =>
            update((p) => ({
              ...p,
              futureHome: { ...p.futureHome, electricHotWaterEnabled: v },
            }))
          }
        />
        <Switch
          label="Piano a induzione"
          text="Cucina in modo moderno ed efficiente."
          checked={f.inductionEnabled}
          onChange={(v) =>
            update((p) => ({
              ...p,
              futureHome: { ...p.futureHome, inductionEnabled: v },
            }))
          }
        />
        <Switch
          label="Auto elettrica"
          text="Per una mobilità più pulita."
          checked={project.mobility.evEnabled}
          onChange={(v) =>
            update((p) => ({ ...p, mobility: { ...p.mobility, evEnabled: v } }))
          }
        />
        <Switch
          label="Mantengo il gas"
          text="Tieni il gas per alcune utenze."
          checked={!f.gasRemoved}
          onChange={(v) =>
            update((p) => ({
              ...p,
              futureHome: { ...p.futureHome, gasRemoved: !v },
            }))
          }
        />
        <button type="button" className="outline wide">
          ⚙ Impostazioni avanzate ›
        </button>
      </aside>
      <div className="future-summary">
        <div>
          <strong>Oggi</strong>
          <b>{Math.round(currentKwh).toLocaleString("it-IT")} kWh</b>
          <span>
            {project.currentHome.heating.gasSmcYear ?? 0} Smc gas/anno
          </span>
        </div>
        <em>→</em>
        <div className="green">
          <strong>Casa futura</strong>
          <b>{futureKwh.toLocaleString("it-IT")} kWh</b>
          <span>{f.gasRemoved ? "niente gas" : "gas mantenuto"}</span>
        </div>
      </div>
      <VisualFooter
        left="Ogni scelta di oggi costruisce un domani migliore."
        right={
          <>
            <button type="button" className="outline">
              Torna indietro
            </button>
            <button type="button" className="yellow">
              Continua ›
            </button>
          </>
        }
      />
    </section>
  );
}
function Switch({
  label,
  text,
  checked,
  onChange,
}: {
  label: string;
  text: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="future-switch">
      <span>
        <strong>{label}</strong>
        <small>{text}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function MobilityStep({ project, update }: StepProps) {
  const m = project.mobility;
  return (
    <section>
      <h1>Mobilità</h1>
      {!m.evEnabled && (
        <p>
          Attiva auto elettrica nello step precedente per visualizzare questi
          carichi nei risultati.
        </p>
      )}
      <div className="form">
        <label>
          Auto attuale
          <select
            value={m.currentVehicle.kind}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: {
                  ...p.mobility,
                  currentVehicle: {
                    ...p.mobility.currentVehicle,
                    kind: e.target
                      .value as Project["mobility"]["currentVehicle"]["kind"],
                  },
                },
              }))
            }
          >
            <option value="petrol">benzina</option>
            <option value="diesel">diesel</option>
            <option value="gpl">GPL</option>
            <option value="electric">elettrica</option>
          </select>
        </label>
        <label>
          Km/anno
          <input
            type="number"
            value={m.futureEv.kmYear}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: {
                  ...p.mobility,
                  futureEv: { ...p.mobility.futureEv, kmYear: +e.target.value },
                  currentVehicle: {
                    ...p.mobility.currentVehicle,
                    kmYear: +e.target.value,
                  },
                },
              }))
            }
          />
        </label>
        <label>
          EV kWh/100 km
          <input
            type="number"
            value={m.futureEv.consumptionKwh100km}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: {
                  ...p.mobility,
                  futureEv: {
                    ...p.mobility.futureEv,
                    consumptionKwh100km: +e.target.value,
                  },
                },
              }))
            }
          />
        </label>
        <label>
          Ricarica domestica %
          <input
            type="number"
            value={m.futureEv.homeChargingShare * 100}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: {
                  ...p.mobility,
                  futureEv: {
                    ...p.mobility.futureEv,
                    homeChargingShare: +e.target.value / 100,
                  },
                },
              }))
            }
          />
        </label>
        <label>
          Profilo ricarica
          <select
            value={m.chargingProfile}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: {
                  ...p.mobility,
                  chargingProfile: e.target
                    .value as Project["mobility"]["chargingProfile"],
                },
              }))
            }
          >
            <option value="night">sera/notte</option>
            <option value="random">quando capita</option>
            <option value="solar">preferibilmente col sole</option>
          </select>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={m.smartChargingEnabled}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: {
                  ...p.mobility,
                  smartChargingEnabled: e.target.checked,
                },
              }))
            }
          />{" "}
          ricarica intelligente
        </label>
      </div>
    </section>
  );
}

function ResultsStep({
  project,
  update,
  results,
  config,
  simulate,
}: {
  project: Project;
  update: UpdateProject;
  results: ScenarioResult[];
  config: AppConfig;
  simulate: () => void;
}) {
  if (!results.length)
    return (
      <section>
        <h1>Risultati</h1>
        <p>Nessuna simulazione ancora eseguita.</p>
        <button type="button" onClick={simulate}>
          Calcola ora
        </button>
      </section>
    );
  const best = Math.max(...results.map((r) => r.score));
  return (
    <section>
      <h1>Risultati</h1>
      <p className="legal">{config.legal.disclaimer}</p>
      <div className="resultgrid">
        {results.map((r) => (
          <article
            key={r.objective}
            className={r.score === best ? "card recommended" : "card"}
          >
            <h2>
              {objectiveLabel(r.objective)}{" "}
              {r.score === best && <small>La nostra scelta</small>}
            </h2>
            <Metric
              label="Potenza"
              value={`${r.pvConfiguration.kwp.toFixed(1)} kWp / ${r.pvConfiguration.panelCount} pannelli`}
            />
            <Metric
              label="Batteria"
              value={`${r.batteryConfiguration.capacityKwh} kWh`}
            />
            <Metric
              label="Produzione"
              value={`${Math.round(r.annualMetrics.pvKwh)} kWh/anno`}
            />
            <Metric
              label="Autoconsumo"
              value={`${r.annualMetrics.selfConsumptionPct.toFixed(0)}%`}
            />
            <Metric
              label="Autosufficienza"
              value={`${r.annualMetrics.selfSufficiencyPct.toFixed(0)}%`}
            />
            <Metric
              label="Prelievo rete"
              value={`${Math.round(r.annualMetrics.gridImportKwh)} kWh`}
            />
            <Metric
              label="Risparmio"
              value={`${Math.round(r.economics.savings)} €/anno`}
            />
            <Metric
              label="Investimento"
              value={`${Math.round(r.economics.investment)} €`}
            />
            <Metric
              label="Payback"
              value={
                r.economics.paybackYears
                  ? `${r.economics.paybackYears.toFixed(1)} anni`
                  : "non raggiunto"
              }
            />
            <Metric label="Affidabilità" value={r.confidence} />
            <p>
              {r.explanationTokens
                .filter((x) => x !== "compared" && x !== "recommended")
                .join(". ")}
              .
            </p>
            {r.warnings.map((w) => (
              <p className="warning" key={w}>
                {w}
              </p>
            ))}
          </article>
        ))}
      </div>
      <h2>Grafico mensile</h2>
      <div className="bars">
        {results[0].monthlyAggregates.map((m) => (
          <div key={m.month}>
            <span>{m.month}</span>
            <b style={{ height: `${Math.min(120, m.pv / 8)}px` }} />
            <i style={{ height: `${Math.min(120, m.load / 8)}px` }} />
          </div>
        ))}
      </div>
      <h2>E se...?</h2>
      <div className="whatif">
        <label>
          <input
            type="checkbox"
            checked={project.mobility.evEnabled}
            onChange={(e) =>
              update((p) => ({
                ...p,
                mobility: { ...p.mobility, evEnabled: e.target.checked },
                results: runSimulation(
                  {
                    ...p,
                    mobility: { ...p.mobility, evEnabled: e.target.checked },
                  },
                  config,
                ),
              }))
            }
          />{" "}
          EV
        </label>
        <label>
          <input
            type="checkbox"
            checked={project.futureHome.heatPumpEnabled}
            onChange={(e) =>
              update((p) => {
                const np = {
                  ...p,
                  futureHome: {
                    ...p.futureHome,
                    heatPumpEnabled: e.target.checked,
                  },
                };
                return { ...np, results: runSimulation(np, config) };
              })
            }
          />{" "}
          PDC
        </label>
        <label>
          <input
            type="checkbox"
            checked={project.mobility.smartChargingEnabled}
            onChange={(e) =>
              update((p) => {
                const np = {
                  ...p,
                  mobility: {
                    ...p.mobility,
                    smartChargingEnabled: e.target.checked,
                  },
                };
                return { ...np, results: runSimulation(np, config) };
              })
            }
          />{" "}
          Ricarica EV intelligente
        </label>
      </div>
      <ImportExport project={project} update={update} />
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function objectiveLabel(o: string) {
  if (o === "minBill") return "Minima bolletta";
  if (o === "maxSelfConsumption") return "Massimo autoconsumo";
  return "Massimo ROI";
}
function ImportExport({
  project,
  update,
}: {
  project: Project;
  update: UpdateProject;
}) {
  return (
    <div className="card">
      <h2>Dati locali</h2>
      <button
        type="button"
        onClick={() => {
          const blob = new Blob([exportProject(project)], {
            type: "application/json",
          });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${project.name}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        }}
      >
        <Download size={16} /> Export JSON
      </button>
      <label className="button">
        <Upload size={16} /> Import JSON
        <input
          hidden
          type="file"
          accept="application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const text = await f.text();
              update(() => importProject(text));
            } catch (err) {
              alert(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      </label>
      <button
        type="button"
        onClick={async () => {
          if (confirm("Eliminare tutti i dati locali?")) await clearAll();
        }}
      >
        Elimina tutti i dati locali
      </button>
      <button
        type="button"
        onClick={async () => {
          if (confirm("Eliminare questo progetto?"))
            await deleteProject(project.id);
        }}
      >
        Elimina progetto
      </button>
    </div>
  );
}

function VisualFooter({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <footer className="visual-footer">
      <span>🌿 {left}</span>
      <span>{right}</span>
    </footer>
  );
}
function pitchLabel(k: string) {
  return k === "flat"
    ? "Quasi piano"
    : k === "low"
      ? "Poco inclinato"
      : k === "normal"
        ? "Normale"
        : "Molto inclinato";
}
function googleMapsPlacesApiKey(config?: AppConfig) {
  const env = import.meta.env as Record<string, string | undefined>;
  return (
    env.VITE_GOOGLE_MAPS_PLACES_API_KEY ??
    env.VITE_GOOGLE_MAPS_API_KEY ??
    (typeof config?.map?.googleMapsApiKey === "string"
      ? config.map.googleMapsApiKey
      : undefined)
  );
}
function loadGoogleMapsPlaces(config?: AppConfig) {
  if (window.google?.maps?.places?.Autocomplete) return Promise.resolve();
  if (window.__googleMapsPlacesPromise) return window.__googleMapsPlacesPromise;

  const key = googleMapsPlacesApiKey(config);
  if (!key)
    return Promise.reject(new Error("Google Maps Places API key mancante"));

  window.__googleMapsPlacesPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-google-maps-places="true"]',
    );
    window.__initGoogleMapsPlaces = () => resolve();
    if (existingScript) return;

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key,
      libraries: "places",
      callback: "__initGoogleMapsPlaces",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMapsPlaces = "true";
    script.onerror = () =>
      reject(new Error("Google Maps Places non disponibile"));
    document.head.appendChild(script);
  });

  return window.__googleMapsPlacesPromise;
}
function googleMapsApiKey(config?: AppConfig) {
  const env = import.meta.env as Record<string, string | undefined>;
  return (
    env.VITE_GOOGLE_MAPS_API_KEY ??
    env.VITE_GOOGLE_MAPS_JS_API_KEY ??
    (typeof config?.map?.googleMapsApiKey === "string"
      ? config.map.googleMapsApiKey
      : undefined)
  );
}
function loadGoogleMapsScript(key: string): Promise<any> {
  if ((window as any).google?.maps?.Map)
    return Promise.resolve((window as any).google);
  if ((window as any).__googleMapsPromise)
    return (window as any).__googleMapsPromise;

  (window as any).__googleMapsPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[data-google-maps="true"]',
    );
    (window as any).__initGoogleMaps = () => resolve((window as any).google);
    if (existingScript) return;

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key,
      libraries: "places",
      callback: "__initGoogleMaps",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMaps = "true";
    script.onerror = () => reject(new Error("Google Maps non disponibile"));
    document.head.appendChild(script);
  });

  return (window as any).__googleMapsPromise;
}
