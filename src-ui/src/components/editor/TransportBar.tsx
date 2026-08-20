import { useState } from "react"
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
  onManualSeekSeconds: (seconds: number) => void
  followPlayhead: boolean
  onToggleFollowPlayhead: () => void
}

/** Parses "mm:ss", "mm:ss.t", or a plain number of seconds into seconds -
 * whichever's quicker to type for a given jump ("1:30" vs "90"). Returns
 * null for anything that isn't one of those shapes, rather than guessing. */
function parseManualPosition(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  if (trimmed.includes(":")) {
    const [minutesPart, secondsPart] = trimmed.split(":")
    const minutes = Number(minutesPart)
    const seconds = Number(secondsPart)
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
    return minutes * 60 + seconds
  }
  const seconds = Number(trimmed)
  return Number.isFinite(seconds) ? seconds : null
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
  onManualSeekSeconds,
  followPlayhead,
  onToggleFollowPlayhead,
}: TransportBarProps) {
  const [manualInput, setManualInput] = useState("")
  const [manualError, setManualError] = useState(false)

  const submitManualSeek = () => {
    const seconds = parseManualPosition(manualInput)
    if (seconds === null) {
      setManualError(true)
      return
    }
    setManualError(false)
    onManualSeekSeconds(seconds)
  }

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

      <div className="transport-manual-seek">
        <input
          type="text"
          className={`transport-manual-seek-input ${manualError ? "invalid" : ""}`}
          placeholder="Start from… (m:ss)"
          value={manualInput}
          onChange={(e) => {
            setManualInput(e.target.value)
            setManualError(false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitManualSeek()
          }}
          title="Jump to an exact position - type m:ss or a number of seconds, then press Enter"
        />
        <button className="btn-icon" onClick={submitManualSeek} title="Go to this position">
          →
        </button>
      </div>

      <button
        className={`transport-follow-toggle ${followPlayhead ? "active" : ""}`}
        onClick={onToggleFollowPlayhead}
        title={
          followPlayhead
            ? "The timeline scrolls to keep the playhead in view during playback (click to stop following)"
            : "The timeline stays put during playback (click to follow the playhead again)"
        }
      >
        {followPlayhead ? "▶ Following" : "▶ Follow"}
      </button>

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
