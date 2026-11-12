import type { AppConfig, RoofPlane } from "../types";
import { roofPlaneStyle } from "./roofColors";

type Props = {
  planes: RoofPlane[];
  config: AppConfig;
  onEdit: () => void;
  onConfirm: () => void;
};

export function RoofPreviewSummary({ planes, config, onEdit, onConfirm }: Props) {
  const usable = planes.filter((plane) => plane.usable);
  const count = usable.reduce((sum, plane) => sum + plane.panels.length, 0);
  return (
    <div className="roof-preview-summary">
      <h2>Disposizione automatica</h2>
      <p>
        Abbiamo confrontato moduli verticali e orizzontali per ogni falda,
        scegliendo la disposizione con più pannelli tra le due.
      </p>
      <div className="summary-strip" role="status" aria-live="polite">
        <strong>{count} pannelli · {((count * config.pv.panel.powerWp) / 1000).toFixed(1)} kWp</strong>
        <br />Capacità massima stimata delle superfici selezionate
      </div>
      <ul className="roof-preview-planes">
        {usable.map((plane) => (
          <li key={plane.id} style={roofPlaneStyle(plane)}>
            <strong>{plane.label}</strong>
            <span>{plane.panels.length} pannelli · {plane.layoutOrientation === "portrait" ? "verticali" : "orizzontali"}</span>
          </li>
        ))}
      </ul>
      {count === 0 && (
        <p role="alert">Nessun pannello entra nelle superfici selezionate con i margini attuali. Modifica o aggiungi una falda.</p>
      )}
      <p className="roof-preview-note">
        Modulo di riferimento: {config.pv.panel.widthM} × {config.pv.panel.heightM} m, {config.pv.panel.powerWp} W.
        La simulazione sceglierà poi la taglia conveniente in base ai consumi.
        Questa disposizione è orientativa e non sostituisce un progetto tecnico.
      </p>
      <div className="roof-preview-actions">
        <button type="button" className="outline" onClick={onEdit}>Modifica superfici</button>
        <button type="button" className="yellow" disabled={count === 0} onClick={onConfirm}>Continua ai consumi ›</button>
      </div>
    </div>
  );
}
