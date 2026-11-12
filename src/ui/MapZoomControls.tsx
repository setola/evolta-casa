type Props = {
  magnification: number;
  ready: boolean;
  onChange: (value: 1 | 2 | 4) => void;
  onRecenter: () => void;
};

export function MapZoomControls({ magnification, ready, onChange, onRecenter }: Props) {
  return (
    <div className="roof-work-zoom" role="group" aria-label="Zoom di lavoro">
      <span>Zoom</span>
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
    </div>
  );
}
