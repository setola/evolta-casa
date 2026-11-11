type Props = {
  magnification: number;
  ready: boolean;
  showVertexHint?: boolean;
  onChange: (value: 1 | 2 | 4) => void;
  onRecenter: () => void;
};

export function MapZoomControls({ magnification, ready, showVertexHint = true, onChange, onRecenter }: Props) {
  return (
    <div className="roof-work-zoom" role="group" aria-label="Zoom di lavoro">
      <span>Zoom disegno</span>
      <div>
        {([1, 2, 4] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`Zoom disegno ${value}×`}
            aria-pressed={magnification === value}
            disabled={!ready}
            onClick={() => onChange(value)}
          >
            {value}×
          </button>
        ))}
        <button type="button" disabled={!ready} onClick={onRecenter}>
          Ricentra
        </button>
      </div>
      <small>
        {showVertexHint && <>Trascina i punti per modificarli.<br /></>}
        Trascina lo sfondo per spostare la vista.
      </small>
    </div>
  );
}
