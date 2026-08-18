import "./TransportBar.css"

interface TransportBarProps {
  playing: boolean
  onPlayPause: () => void
  onStop: () => void
  positionLabel: string
  zoom: number
  onZoomChange: (zoom: number) => void
  saving: boolean
  exporting: boolean
  dirty: boolean
  onSave: () => void
  onExport: () => void
  onExit: () => void
}

export function TransportBar({
  playing,
  onPlayPause,
  onStop,
  positionLabel,
  zoom,
  onZoomChange,
  saving,
  exporting,
  dirty,
  onSave,
  onExport,
  onExit,
}: TransportBarProps) {
  return (
    <div className="transport-bar">
      <button className="btn-icon" onClick={onExit} title="Back to Recordings">
        ←
      </button>
      <button className="btn btn-primary" onClick={onPlayPause}>
        {playing ? "Pause" : "Play"}
      </button>
      <button className="btn btn-secondary" onClick={onStop}>
        Stop
      </button>
      <span className="transport-time">{positionLabel}</span>

      <div className="transport-zoom">
        <span>Zoom</span>
        <input
          type="range"
          min={10}
          max={400}
          step={5}
          value={zoom}
          onChange={(e) => onZoomChange(Number(e.target.value))}
        />
      </div>

      <div className="transport-actions">
        <button className="btn btn-secondary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : dirty ? "Save*" : "Save"}
        </button>
        <button className="btn btn-record" onClick={onExport} disabled={exporting}>
          {exporting ? "Exporting…" : "Export Mixdown"}
        </button>
      </div>
    </div>
  )
}
