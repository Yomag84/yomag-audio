import type { Clip, TrackProject } from "../../types"
import type { PeakData } from "../../lib/waveform"
import { ClipCanvas } from "./ClipCanvas"
import "./TrackLane.css"

interface TrackLaneProps {
  label: string
  color: string
  track: TrackProject
  peaks: PeakData
  sourceDurationFrames: number
  sampleRate: number
  pixelsPerSecond: number
  playheadFrame: number
  selectedClipId: string | null
  fxOpen: boolean
  onSelectClip: (clipId: string | null) => void
  onSeek: (frame: number) => void
  onClipsChange: (clips: Clip[]) => void
  onGainChange: (gain: number) => void
  onMuteToggle: () => void
  onSoloToggle: () => void
  onSplit: () => void
  onDeleteSelectedClip: () => void
  onOpenFx: () => void
}

export function TrackLane({
  label,
  color,
  track,
  peaks,
  sourceDurationFrames,
  sampleRate,
  pixelsPerSecond,
  playheadFrame,
  selectedClipId,
  fxOpen,
  onSelectClip,
  onSeek,
  onClipsChange,
  onGainChange,
  onMuteToggle,
  onSoloToggle,
  onSplit,
  onDeleteSelectedClip,
  onOpenFx,
}: TrackLaneProps) {
  const hasSelectedClip = track.clips.some((c) => c.id === selectedClipId)

  return (
    <div className="track-lane">
      <div className="track-lane-color" style={{ background: color }} />
      <div className="track-lane-header">
        <span className="track-lane-name" title={label}>
          {label}
        </span>
        <div className="track-lane-controls">
          <button
            className={`track-toggle ${track.muted ? "active" : ""}`}
            onClick={onMuteToggle}
            title="Mute this track"
          >
            M
          </button>
          <button
            className={`track-toggle solo ${track.solo ? "active" : ""}`}
            onClick={onSoloToggle}
            title="Solo this track"
          >
            S
          </button>
          <input
            type="range"
            className="track-gain-slider"
            min={0}
            max={2}
            step={0.01}
            value={track.gain}
            onChange={(e) => onGainChange(Number(e.target.value))}
            title={`Gain ${Math.round(track.gain * 100)}%`}
          />
          <button className={`track-action-btn ${fxOpen ? "active" : ""}`} onClick={onOpenFx} title="Parametric EQ">
            FX
          </button>
          <button className="track-action-btn" onClick={onSplit} title="Split the clip under the playhead">
            Split
          </button>
          <button
            className="track-action-btn"
            onClick={onDeleteSelectedClip}
            disabled={!hasSelectedClip}
            title="Delete the selected clip"
          >
            Delete
          </button>
        </div>
      </div>
      <ClipCanvas
        clips={track.clips}
        peaks={peaks}
        sourceDurationFrames={sourceDurationFrames}
        sampleRate={sampleRate}
        pixelsPerSecond={pixelsPerSecond}
        playheadFrame={playheadFrame}
        selectedClipId={selectedClipId}
        color={color}
        onClipsChange={onClipsChange}
        onSelectClip={onSelectClip}
        onSeek={onSeek}
      />
    </div>
  )
}
