import type { EffectReturn, EqBand, TrackProject } from "../../types"
import { colorForTrack } from "../../lib/trackColors"
import { Knob } from "./Knob"
import { EffectsRack } from "./EffectsRack"
import "./MixerView.css"

interface MixerViewProps {
  tracks: TrackProject[]
  returns: EffectReturn[]
  onGainChange: (sourceId: string, gain: number) => void
  onPanChange: (sourceId: string, pan: number) => void
  onMuteToggle: (sourceId: string) => void
  onSoloToggle: (sourceId: string) => void
  onEqChange: (sourceId: string, bands: EqBand[]) => void
  onSendChange: (sourceId: string, returnId: string, amount: number) => void
  openFxTrackId: string | null
  onToggleFx: (sourceId: string) => void
  onExportTrack: (sourceId: string) => void
  exportingTrackId: string | null
}

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.02) return "C"
  const pct = Math.round(Math.abs(pan) * 100)
  return pan < 0 ? `L${pct}` : `R${pct}`
}

/**
 * Channel-strip mixer view: one strip per track (colored top bar, name,
 * pan knob, mute/solo, a vertical gain fader, and an FX button opening
 * the same EffectsRack the Main page's track lanes use) - the "Mixer"
 * page of the editor's Main/Mixer tab pair.
 */
export function MixerView({
  tracks,
  returns,
  onGainChange,
  onPanChange,
  onMuteToggle,
  onSoloToggle,
  onEqChange,
  onSendChange,
  openFxTrackId,
  onToggleFx,
  onExportTrack,
  exportingTrackId,
}: MixerViewProps) {
  if (tracks.length === 0) {
    return (
      <div className="mixer-view">
        <p className="routing-empty">No tracks in this session</p>
      </div>
    )
  }

  return (
    <div className="mixer-view">
      {tracks.map((track) => {
        const color = colorForTrack(track.source_id)
        return (
          <div key={track.source_id} className="mixer-strip-column">
            <div className="mixer-strip">
              <div className="mixer-strip-color" style={{ background: color }} />
              <div className="mixer-strip-body">
                <span className="mixer-strip-name" title={track.source_id}>
                  {track.source_id}
                </span>

                <Knob
                  value={track.pan}
                  min={-1}
                  max={1}
                  color={color}
                  label={panLabel(track.pan)}
                  onChange={(pan) => onPanChange(track.source_id, pan)}
                />

                <div className="mixer-strip-buttons">
                  <button
                    className={`track-toggle ${track.muted ? "active" : ""}`}
                    onClick={() => onMuteToggle(track.source_id)}
                    title="Mute"
                  >
                    M
                  </button>
                  <button
                    className={`track-toggle solo ${track.solo ? "active" : ""}`}
                    onClick={() => onSoloToggle(track.source_id)}
                    title="Solo"
                  >
                    S
                  </button>
                </div>

                <div className="mixer-fader-track">
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={track.gain}
                    onChange={(e) => onGainChange(track.source_id, Number(e.target.value))}
                    style={{ accentColor: color }}
                    title={`Gain ${Math.round(track.gain * 100)}%`}
                  />
                </div>
                <span className="mixer-strip-gain-label">{Math.round(track.gain * 100)}%</span>

                {returns.length > 0 && (
                  <div className="mixer-strip-sends">
                    {returns.map((r) => (
                      <Knob
                        key={r.id}
                        value={track.sends[r.id] ?? 0}
                        min={0}
                        max={1}
                        color="var(--accent2)"
                        label={r.name}
                        onChange={(amount) => onSendChange(track.source_id, r.id, amount)}
                      />
                    ))}
                  </div>
                )}

                <button
                  className={`track-action-btn ${openFxTrackId === track.source_id ? "active" : ""}`}
                  onClick={() => onToggleFx(track.source_id)}
                >
                  FX
                </button>

                <button
                  className="track-action-btn mixer-strip-save"
                  onClick={() => onExportTrack(track.source_id)}
                  disabled={exportingTrackId === track.source_id}
                  title="Save this track's own edit list (clips, gain, pan, EQ) to its own WAV file"
                >
                  {exportingTrackId === track.source_id ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            {openFxTrackId === track.source_id && (
              <EffectsRack
                bands={track.eq_bands}
                onChange={(bands) => onEqChange(track.source_id, bands)}
                onClose={() => onToggleFx(track.source_id)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
