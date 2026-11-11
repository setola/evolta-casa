import { ChevronDown } from "lucide-react";
import type { RoofPlane } from "../types";

type Props = {
  planes: RoofPlane[];
  activePlane?: RoofPlane;
  open: boolean;
  drawing: boolean;
  busy: boolean;
  ready: boolean;
  pointCount: number;
  onToggle: () => void;
  onPlaneChange: (id: string) => void;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: (id: string) => void;
};

export function RoofSubdivisions({
  planes, activePlane, open, drawing, busy, ready, pointCount,
  onToggle, onPlaneChange, onStart, onCancel, onSave, onDelete,
}: Props) {
  return (
    <>
      <button
        type="button"
        id="roof-subdivision-toggle"
        className="roof-accordion-toggle"
        aria-expanded={open}
        aria-controls="roof-subdivision-editor"
        disabled={busy}
        onClick={onToggle}
      >
        Suddivisioni interne
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          id="roof-subdivision-editor"
          className="roof-subdivision-editor"
          role="region"
          aria-labelledby="roof-subdivision-toggle"
        >
          <p>
            Seleziona la falda e indica i due estremi di una separazione interna.
            Per superfici con inclinazioni diverse, disegna due falde distinte.
          </p>
          <label>
            Falda da suddividere
            <select
              value={activePlane?.id ?? ""}
              disabled={busy || !activePlane}
              onChange={(event) => onPlaneChange(event.target.value)}
            >
              {planes.map((plane) => (
                <option key={plane.id} value={plane.id}>{plane.label}</option>
              ))}
            </select>
          </label>
          {drawing ? (
            <div className="panel-drawing-controls">
              <span>{pointCount}/2 estremi</span>
              <button type="button" className="yellow" disabled={pointCount !== 2} onClick={onSave}>
                Salva separazione
              </button>
              <button type="button" className="outline" onClick={onCancel}>
                Annulla separazione
              </button>
            </div>
          ) : (
            <button type="button" disabled={!ready || busy || !activePlane} onClick={onStart}>
              + Indica separazione falda
            </button>
          )}
          {(activePlane?.slopeLines ?? []).map((line) => (
            <div className="panel-list-row" key={line.id}>
              <span>{line.label}</span>
              <button type="button" disabled={busy || drawing} onClick={() => onDelete(line.id)}>
                Elimina separazione
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
