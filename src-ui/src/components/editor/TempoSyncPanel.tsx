import "./TempoSyncPanel.css"

interface TempoSyncPanelProps {
  tempoBpm: number
  metronomeEnabled: boolean
  onTempoChange: (bpm: number) => void
  onMetronomeToggle: (enabled: boolean) => void
}

/**
 * "Tempo & Sync" console panel: a BPM value and a metronome click during
 * preview playback. Host Sync/Count In/Remote from a typical hardware
 * recorder's panel are deliberately not here - this editor has no host
 * transport to sync to and never records live (recording happens from the
 * Routing view), so those controls would have nothing real to do.
 */
export function TempoSyncPanel({
  tempoBpm,
  metronomeEnabled,
  onTempoChange,
  onMetronomeToggle,
}: TempoSyncPanelProps) {
  return (
    <div className="console-panel tempo-sync-panel">
      <h4>Tempo &amp; Sync</h4>
      <div className="tempo-row">
        <span className="tempo-label">Tempo</span>
        <input
          type="number"
          className="tempo-input"
          min={20}
          max={300}
          step={1}
          value={Math.round(tempoBpm)}
          onChange={(e) => onTempoChange(Number(e.target.value))}
        />
        <span className="tempo-unit">BPM</span>
      </div>
      <button
        className={`tempo-metronome-toggle ${metronomeEnabled ? "active" : ""}`}
        onClick={() => onMetronomeToggle(!metronomeEnabled)}
        title="Click plays during preview only - never included in the exported mixdown"
      >
        {metronomeEnabled ? "♪ Metronome On" : "♪ Metronome Off"}
      </button>
      <p className="tempo-hint">Click is a preview aid only - it's never in the exported mixdown.</p>
    </div>
  )
}
